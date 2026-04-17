import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  Loader2,
  CloudRain,
  Thermometer,
  Droplets,
  Wind,
  AlertTriangle,
  Wifi,
  MapPin,
  AlertCircle,
  RadioTower,
} from "lucide-react";
import { DisruptionEvent, DisruptionSeverity } from "@/types";
import { fetchMLFraudScore } from "@/hooks/useMLApi";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const triggerTypes = [
  {
    id: "rain",
    name: "Heavy Rain",
    icon: CloudRain,
    reading: "18mm/hr",
    threshold: "> 20mm/hr",
    source: "OpenWeatherMap",
  },
  {
    id: "heat",
    name: "Extreme Heat",
    icon: Thermometer,
    reading: "38°C",
    threshold: "> 42°C",
    source: "OpenWeatherMap",
  },
  {
    id: "flood",
    name: "Flood Alert",
    icon: Droplets,
    reading: "Normal",
    threshold: "Alert Level",
    source: "IMD API",
  },
  {
    id: "aqi",
    name: "Severe AQI",
    icon: Wind,
    reading: "142",
    threshold: "> 300",
    source: "AQICN API",
  },
  {
    id: "curfew",
    name: "Curfew / Strike",
    icon: AlertTriangle,
    reading: "None",
    threshold: "Active",
    source: "NewsAPI",
  },
  {
    id: "platform",
    name: "Platform Order Drop",
    icon: Wifi,
    reading: "92%",
    threshold: "< 60%",
    source: "Mock API",
  },
  {
    id: "gps",
    name: "GPS Dead Zone",
    icon: MapPin,
    reading: "Active",
    threshold: "No Signal",
    source: "GPS Layer",
  },
];

const TYPE_DB: Record<string, { reading: string; threshold: string }> = {
  rain: { reading: "28mm/hr", threshold: ">20mm/hr" },
  heat: { reading: "43°C", threshold: ">42°C" },
  flood: { reading: "Red Alert Active", threshold: "Red Alert issued" },
  aqi: { reading: "AQI 315", threshold: "AQI >300" },
  curfew: { reading: "Section 144 Active", threshold: "Confirmed event" },
  platform: { reading: "75% order drop", threshold: ">70% drop" },
  gps: { reading: "Dead zone 90min", threshold: ">90min no orders" },
};

const BASE_PAYOUT: Record<string, number> = {
  rain: 300,
  heat: 200,
  flood: 400,
  aqi: 200,
  curfew: 350,
  platform: 250,
  gps: 200,
};

function baseForType(t: string): number {
  return BASE_PAYOUT[t] ?? 200;
}

/** Severity badge ────────────────────────────────────────────── */
function SeverityBadge({ severity }: { severity: string | null | undefined }) {
  const s = (severity || "low").toLowerCase();
  const map: Record<string, string> = {
    low: "badge-low",
    medium: "badge-medium",
    high: "badge-high",
    critical: "badge-critical",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${
        map[s] ?? "badge-low"
      }`}
    >
      {s}
    </span>
  );
}

const Triggers = () => {
  const [disruptions, setDisruptions] = useState<DisruptionEvent[]>([]);
  const [recentEvents, setRecentEvents] = useState<DisruptionEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [simType, setSimType] = useState("rain");
  const [simZone, setSimZone] = useState("Koramangala");
  const [simPincode, setSimPincode] = useState("560034");
  const [simulating, setSimulating] = useState(false);

  const load = useCallback(async () => {
    const [activeRes, allRes] = await Promise.all([
      supabase.from("disruptions").select("*").eq("status", "active"),
      supabase
        .from("disruptions")
        .select("*")
        .order("triggered_at", { ascending: false })
        .limit(10),
    ]);
    setDisruptions((activeRes.data as DisruptionEvent[]) || []);
    setRecentEvents((allRes.data as DisruptionEvent[]) || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const simulate = async () => {
    setSimulating(true);
    const meta = TYPE_DB[simType] || TYPE_DB.rain!;

    try {
      // Send the payload to the Python Gateway we just built
      const payload = {
        source_api: "Demo Simulation",
        trigger_type: simType,
        zone: simZone,
        pincode: simPincode,
        reading_value: parseFloat(meta.reading) || 100, 
        reading_unit: meta.reading.replace(/[0-9.]/g, '') || "raw",
        threshold_limit: parseFloat(meta.threshold) || 50,
        is_breached: true
      };

      const res = await fetch("http://localhost:8000/api/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error("Failed to process simulation via Gateway API");
      
      const data = await res.json();
      
      if (data.status === "processed" && data.workers_compensated > 0) {
          toast.success(`Disruption triggered in ${simZone}. Processed payouts for ${data.workers_compensated} worker(s).`);
      } else if (data.status === "processed") {
          toast.info(`Disruption recorded in ${simZone}, but no active workers found in pincode ${simPincode}.`);
      } else {
          toast.info(`Result: ${data.message || data.status}`);
      }

      setModalOpen(false);
      // Sleep to let Supabase catch up before fetching new data
      await sleep(1000);
      await load();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to simulate");
    } finally {
      setSimulating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const activeIds = new Set(disruptions.map((d: DisruptionEvent) => d.type));

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">
            Disruption Monitor
          </h1>
          <p className="text-sm text-muted-foreground flex items-center gap-1.5">
            <RadioTower className="h-3.5 w-3.5" />
            Monitoring 7 data sources every 15 minutes
          </p>
        </div>
        <Button
          onClick={() => setModalOpen(true)}
          variant="destructive"
          className="gap-2"
        >
          <AlertCircle className="h-4 w-4" />
          Simulate Disruption
        </Button>
      </div>

      {/* Sensor cards grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {triggerTypes.map((t) => {
          const isActive = activeIds.has(t.id);
          const activeDisruption = disruptions.find(
            (d: DisruptionEvent) => d.type === t.id
          );

          return (
            <div
              key={t.id}
              className={[
                "glass-card rounded-2xl p-5 space-y-3 transition-all duration-300",
                isActive
                  ? "border-red-500/25 shadow-[0_0_20px_rgba(239,68,68,0.08)]"
                  : "",
              ].join(" ")}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <t.icon
                    className={`h-5 w-5 ${
                      isActive ? "text-red-400" : "text-primary"
                    }`}
                  />
                  <span className="text-sm font-semibold">{t.name}</span>
                </div>
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide border ${
                    isActive ? "badge-active" : "badge-normal"
                  }`}
                >
                  {isActive ? "TRIGGERED" : "NORMAL"}
                </span>
              </div>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Reading</span>
                  <span
                    className={`font-semibold ${
                      isActive ? "text-red-400" : "text-foreground"
                    }`}
                  >
                    {activeDisruption?.reading || t.reading}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Threshold</span>
                  <span className="text-muted-foreground text-xs">
                    {t.threshold}
                  </span>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Source: {t.source}
              </p>
            </div>
          );
        })}
      </div>

      {/* Recent events table */}
      <div className="glass-card rounded-2xl p-6">
        <h2 className="mb-4 font-semibold text-sm uppercase tracking-wider text-muted-foreground">
          Recent Trigger Events
        </h2>
        {recentEvents.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow className="border-white/[0.06]">
                <TableHead>Time</TableHead>
                <TableHead>Event ID</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Zone</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentEvents.map((e: DisruptionEvent) => (
                <TableRow key={e.id} className="border-white/[0.04]">
                  <TableCell className="text-xs text-muted-foreground">
                    {e.triggered_at
                      ? new Date(e.triggered_at).toLocaleString()
                      : "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {e.event_id}
                  </TableCell>
                  <TableCell className="capitalize font-medium">
                    {e.type?.replace("_", " ")}
                  </TableCell>
                  <TableCell className="text-sm">{e.zone}</TableCell>
                  <TableCell>
                    <SeverityBadge severity={e.severity} />
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        e.status === "active" ? "default" : "secondary"
                      }
                    >
                      {e.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="py-6 text-sm text-muted-foreground text-center">
            All signals normal. No disruptions detected.
          </p>
        )}
      </div>

      {/* Simulate dialog */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="border border-white/10 bg-card dark:bg-[#0d1628] backdrop-blur-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-destructive" />
              Simulate Disruption
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Disruption Type</Label>
              <Select value={simType} onValueChange={setSimType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {triggerTypes.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Zone</Label>
              <Input
                value={simZone}
                onChange={(e) => setSimZone(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Pincode</Label>
              <Input
                value={simPincode}
                onChange={(e) => setSimPincode(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setModalOpen(false)}
              className="border-white/10 bg-white/5 hover:bg-white/10"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={simulate}
              disabled={simulating}
              className="gap-2"
            >
              {simulating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Triggering...
                </>
              ) : (
                <>
                  <AlertCircle className="h-4 w-4" /> Trigger Disruption
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Triggers;
