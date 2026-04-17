from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Literal
from datetime import datetime
import httpx
import os
import asyncio
import random
from contextlib import asynccontextmanager
from dotenv import load_dotenv

env_path = os.path.join(os.path.dirname(__file__), '../../.env')
load_dotenv(env_path)

from supabase import create_client, Client
SUPABASE_URL = os.getenv("VITE_SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("VITE_SUPABASE_PUBLISHABLE_KEY", "")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

class NormalizedReading(BaseModel):
    source_api: str               # e.g., "OpenWeatherMap", "AQICN", "Simulated"
    trigger_type: Literal["rain", "heat", "flood", "aqi", "curfew", "platform", "gps"]
    zone: str                     # e.g., "Koramangala"
    pincode: str                  # e.g., "560034"
    reading_value: float          # e.g., 65.5
    reading_unit: str             # e.g., "mm/hr", "AQI", "°C"
    threshold_limit: float        # e.g., 50.0
    is_breached: bool             # reading_value > threshold_limit
    timestamp: datetime = Field(default_factory=datetime.utcnow)

# Define ML_SERVICE_URL and http_client before functions that use them
ML_SERVICE_URL = os.getenv("ML_SERVICE_URL", "http://127.0.0.1:8001")

http_client = httpx.AsyncClient(
    base_url=ML_SERVICE_URL,
    timeout=15.0,
)

async def process_disruption_reading(reading: NormalizedReading) -> dict:
    """Core logic to handle a reading and process payouts if breached."""
    if not reading.is_breached:
        return {"status": "ignored", "message": f"{reading.trigger_type} limit not breached."}

    event_id = f"EVT-{reading.zone[:3].upper()}-{reading.trigger_type.upper()}-{int(reading.timestamp.timestamp())}"

    # 1. Insert Disruption into DB
    disruption_data = {
        "event_id": event_id,
        "type": reading.trigger_type,
        "zone": reading.zone,
        "pincode": reading.pincode,
        "severity": "high",
        "reading": f"{reading.reading_value}{reading.reading_unit}",
        "threshold": f"{reading.threshold_limit}{reading.reading_unit}",
        "status": "active"
    }

    d_res = supabase.table("disruptions").insert(disruption_data).execute()
    if not d_res.data:
        return {"status": "error", "message": "Failed to insert disruption."}
    disruption_id = d_res.data[0]["id"]

    # 2. Find eligible workers in that Pincode
    workers_res = supabase.table("workers").select("id, earnings_baseline, upi_id, trust_score").eq("pincode", reading.pincode).execute()
    workers = workers_res.data

    base_payouts = {"rain": 300, "heat": 200, "flood": 400, "aqi": 200, "curfew": 350, "platform": 250, "gps": 200}
    primary_base = base_payouts.get(reading.trigger_type, 200)
    
    processed_count = 0
    payout_details = []

    for w in workers:
        pol_res = supabase.table("policies").select("max_payout").eq("worker_id", w["id"]).eq("status", "active").execute()
        if not pol_res.data:
            continue
            
        max_payout = float(pol_res.data[0]["max_payout"])
        baseline = float(w["earnings_baseline"] or 1000)
        
        payout_amount = min(primary_base, max_payout)
        protection_pct = int((payout_amount / baseline) * 100)

        # 3. Create Claim
        explainer = f"Event #{event_id}: {reading.trigger_type} detected. Baseline: ₹{baseline}. Protected at {protection_pct}% = ₹{payout_amount} credited."
        claim_data = {
            "worker_id": w["id"],
            "disruption_id": disruption_id,
            "payout_amount": payout_amount,
            "baseline_earnings": baseline,
            "protection_percentage": protection_pct,
            "explainer_text": explainer,
            "status": "processing",
            "fraud_flag": False
        }
        
        c_res = supabase.table("claims").insert(claim_data).execute()
        claim_id = c_res.data[0]["id"]

        # Call ML Fraud logic
        fraud_req = {
            "trust_score": w.get("trust_score", 100),
            "gps_speed_kmph": 0.0,
            "gps_jump_km": 0.0,
            "gps_in_zone": 1,
            "api_confirmed": 1,
            "same_event_claims_count": 1,
            "pincode_changes_30days": 0,
            "weekly_claims": 1,
            "avg_weekly_claims": 0.5,
            "claim_spike_ratio": 1.0,
            "payout_amount": payout_amount,
            "earnings_baseline": baseline,
            "payout_vs_baseline_ratio": payout_amount / baseline if baseline else 0.0,
            "hours_since_last_claim": 168.0,
            "zone_disruption_confirmed": 1,
            "neighbor_zone_payout": 0
        }
        
        try:
            # We use our connected httpx client pointing to ML_SERVICE_URL
            fraud_resp = await http_client.post("/api/fraud/score", json=fraud_req)
            fraud_resp.raise_for_status()
            fraud_data = fraud_resp.json()
            is_fraudulent = fraud_data.get("fraud_score", 0) > 60
        except Exception as e:
            print(f"Fraud check failed: {e}")
            is_fraudulent = False

        if is_fraudulent:
            # Flag claim and skip automated payout
            supabase.table("claims").update({"fraud_flag": True, "status": "processing"}).eq("id", claim_id).execute()
            continue

        # 4. Approve Claim & Create Payout
        supabase.table("claims").update({"status": "paid", "approved_at": datetime.utcnow().isoformat()}).eq("id", claim_id).execute()
        
        supabase.table("payouts").insert({
            "claim_id": claim_id,
            "worker_id": w["id"],
            "amount": payout_amount,
            "upi_id": w.get("upi_id") or "UPI",
            "status": "completed"
        }).execute()
        
        processed_count += 1
        payout_details.append({"worker_id": w["id"], "amount": payout_amount, "upi": w.get("upi_id")})

    return {
        "status": "processed",
        "event_id": event_id,
        "workers_compensated": processed_count,
        "payouts": payout_details
    }


# -- BACKGROUND POLLER --
async def fetch_real_weather_reading() -> NormalizedReading:
    """Fetch real-time weather API for Koramangala using Open-Meteo (No API key required)."""
    # Koramangala, Bangalore Coordinates
    lat, lon = 12.9246, 77.6225
    url = f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m,rain&timezone=Asia/Kolkata"
    
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(url, timeout=10.0)
            response.raise_for_status()
            data = response.json()
            
            current = data.get("current", {})
            rain_mm = current.get("rain", 0.0)
            temp_c = current.get("temperature_2m", 0.0)
            
            # Decide which trigger to evaluate based on severity
            if rain_mm > 0.5:
                trigger_type = "rain"
                reading_val = rain_mm
                unit = "mm"
                threshold = 2.0  # low threshold for demo purposes
            else:
                trigger_type = "heat"
                reading_val = temp_c
                unit = "°C"
                threshold = 36.0 # 36 degree threshold for heatwave simulation
                
            return NormalizedReading(
                source_api="Open-Meteo (Real-Time API)",
                trigger_type=trigger_type,
                zone="Koramangala",
                pincode="560034",
                reading_value=reading_val,
                reading_unit=unit,
                threshold_limit=threshold,
                is_breached=reading_val >= threshold
            )
            
    except Exception as e:
        print(f"Error fetching real weather API: {e}")
        # Return a safe fallback if the API fails
        return NormalizedReading(
            source_api="API Fallback",
            trigger_type="heat",
            zone="Koramangala",
            pincode="560034",
            reading_value=30.0,
            reading_unit="°C",
            threshold_limit=36.0,
            is_breached=False
        )

async def api_polling_loop():
    """Background task polling real APIs periodically."""
    print("Background API Poller Started... connected to Open-Meteo")
    while True:
        # Every interval, fetch real weather reading
        reading = await fetch_real_weather_reading()
        print(f"Polled {reading.source_api} for {reading.zone}. Reading: {reading.reading_value}{reading.reading_unit}. Breached: {reading.is_breached}")
        
        if reading.is_breached:
            print(f"⚠️ {reading.trigger_type.upper()} THRESHOLD BREACHED. Triggering background automated payout processing...")
            await process_disruption_reading(reading)
        
        # Check every 60 seconds
        await asyncio.sleep(60)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Create background polling task
    poller_task = asyncio.create_task(api_polling_loop())
    yield
    # Shutdown: Cancel task
    poller_task.cancel()


app = FastAPI(title="Nimbus API Gateway", version="1.0.0", lifespan=lifespan)

@app.post("/api/simulate")
async def simulate_disruption(reading: NormalizedReading):
    """
    Receives API data and automatically processes payouts via Supabase.
    """
    return await process_disruption_reading(reading)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
async def health():
    """Gateway health + ML service connectivity check."""
    try:
        resp = await http_client.get("/health")
        ml_data = resp.json()
        return {
            "status": "ok",
            "gateway": "healthy",
            "ml_service": "connected",
            "ml_models": ml_data.get("models", []),
        }
    except Exception as e:
        raise HTTPException(
            status_code=503,
            detail=f"ML service unreachable at {ML_SERVICE_URL}: {str(e)}",
        )


class PremiumRequest(BaseModel):
    zone_risk_score: int
    earnings_baseline: float
    trust_score: int
    past_claims_count: int
    claim_approval_rate: float
    weeks_active: int
    forecast_rain_mm: float
    forecast_aqi: int
    tier: str
    city: str
    month: int


@app.post("/api/premium/calculate")
async def calculate_premium(req: PremiumRequest):
    try:
        resp = await http_client.post(
            "/api/premium/calculate",
            json=req.model_dump(),
        )
        resp.raise_for_status()
        return resp.json()
    except httpx.HTTPStatusError as e:
        raise HTTPException(
            status_code=e.response.status_code,
            detail=f"ML service error: {e.response.text}",
        )
    except httpx.RequestError as e:
        raise HTTPException(
            status_code=503,
            detail=f"ML service unreachable: {str(e)}",
        )


class FraudRequest(BaseModel):
    trust_score: int
    gps_speed_kmph: float
    gps_jump_km: float
    gps_in_zone: int
    api_confirmed: int
    same_event_claims_count: int
    pincode_changes_30days: int
    weekly_claims: int
    avg_weekly_claims: float
    claim_spike_ratio: float
    payout_amount: float
    earnings_baseline: float
    payout_vs_baseline_ratio: float
    hours_since_last_claim: float
    zone_disruption_confirmed: int
    neighbor_zone_payout: int


@app.post("/api/fraud/score")
async def score_fraud(req: FraudRequest):
    try:
        resp = await http_client.post(
            "/api/fraud/score",
            json=req.model_dump(),
        )
        resp.raise_for_status()
        return resp.json()
    except httpx.HTTPStatusError as e:
        raise HTTPException(
            status_code=e.response.status_code,
            detail=f"ML service error: {e.response.text}",
        )
    except httpx.RequestError as e:
        raise HTTPException(
            status_code=503,
            detail=f"ML service unreachable: {str(e)}",
        )


@app.on_event("shutdown")
async def shutdown():
    await http_client.aclose()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
