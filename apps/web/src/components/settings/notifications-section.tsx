import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { GroupLabel, Section } from "@/components/settings-ui.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { rpc, unwrap } from "@/lib/api.ts";
import { disablePush, enablePush, isPushEnabled, pushSupported } from "@/lib/push.ts";
import type { MailboxSummary } from "@/lib/queries.ts";

type NotifyLevel = "none" | "normal" | "important";
type NotifyTiers = { high: NotifyLevel; normal: NotifyLevel; low: NotifyLevel };
type NotifyConfig = NotifyTiers & { mailboxId: string };

const DEFAULT_TIERS: NotifyTiers = { high: "important", normal: "normal", low: "normal" };
const OFF_TIERS: NotifyTiers = { high: "none", normal: "none", low: "none" };

const NOTIFY_TIERS = [
  { key: "high", label: "Important email" },
  { key: "normal", label: "Normal email" },
  { key: "low", label: "Low-priority email" },
] as const;

const LEVEL_OPTS = [
  { value: "none", label: "None" },
  { value: "normal", label: "Normal" },
  { value: "important", label: "Important" },
];

function stripId(c: NotifyConfig): NotifyTiers {
  return { high: c.high, normal: c.normal, low: c.low };
}

// iOS only delivers Web Push to a PWA installed on the Home Screen; in Safari
// itself the push APIs don't exist, so `pushSupported()` is false there.
const IS_IOS = typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent);

export function NotificationsSection({ mailboxes }: { mailboxes: MailboxSummary[] }) {
  const qc = useQueryClient();
  const supported = pushSupported();
  const [deviceOn, setDeviceOn] = useState(false);
  const [busy, setBusy] = useState(false);

  // Service mailboxes are send-only — they never receive mail to notify on.
  const receivable = mailboxes.filter((m) => m.type !== "service");

  useEffect(() => {
    isPushEnabled()
      .then(setDeviceOn)
      .catch(() => {});
  }, []);

  const toggleDevice = async () => {
    setBusy(true);
    try {
      if (deviceOn) {
        await disablePush();
        setDeviceOn(false);
        toast.success("Notifications disabled on this device");
      } else {
        await enablePush();
        setDeviceOn(true);
        // An account with zero mailbox configs would notify on nothing —
        // default every mailbox on so enabling a first device just works.
        const { configs } = await unwrap(rpc.push.mailboxes.$get());
        if (configs.length === 0 && receivable.length > 0) {
          await Promise.all(
            receivable.map((m) =>
              unwrap(rpc.push.mailboxes[":id"].$put({ param: { id: m.id }, json: DEFAULT_TIERS })),
            ),
          );
          qc.invalidateQueries({ queryKey: ["push-mailboxes"] });
        }
        toast.success("Notifications enabled on this device");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const { data: configsData } = useQuery({
    queryKey: ["push-mailboxes"],
    queryFn: () => unwrap(rpc.push.mailboxes.$get()),
  });
  const configById = new Map((configsData?.configs ?? []).map((c) => [c.mailboxId, c]));

  const saveConfig = useMutation({
    mutationFn: ({ id, cfg }: { id: string; cfg: NotifyTiers }) =>
      unwrap(rpc.push.mailboxes[":id"].$put({ param: { id }, json: cfg })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["push-mailboxes"] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  return (
    <Section
      id="notifications"
      title="Notifications"
      description="Get a push notification when new mail arrives. Enable this device, then choose how each mailbox notifies you — AI tags every email's priority so important mail can stand out."
    >
      <div className="flex items-center justify-between gap-4">
        <div className="text-[13px]">
          <div className="font-medium">This device</div>
          <div className="text-[12px] text-muted-foreground">
            {supported
              ? deviceOn
                ? "Receiving notifications"
                : "Not enabled"
              : IS_IOS
                ? "On iPhone, install the app first: Share → Add to Home Screen, then enable notifications from there"
                : "Not supported in this browser"}
          </div>
        </div>
        <Button variant="primary" onClick={toggleDevice} disabled={!supported || busy}>
          {deviceOn ? "Disable" : "Enable"}
        </Button>
      </div>

      {receivable.length > 0 && (
        <div className="mt-4 border-t pt-4">
          <GroupLabel className="mb-1.5">Per mailbox</GroupLabel>
          <ul className="divide-y">
            {receivable.map((m) => {
              const cfg = configById.get(m.id);
              const on = !!cfg;
              return (
                <li key={m.id} className="py-2.5 text-[13px]">
                  <div className="flex items-center justify-between gap-4">
                    <span className="min-w-0 truncate">{m.displayName ?? m.address}</span>
                    <Switch
                      checked={on}
                      disabled={saveConfig.isPending}
                      onCheckedChange={(checked) =>
                        saveConfig.mutate({
                          id: m.id,
                          cfg: checked ? DEFAULT_TIERS : OFF_TIERS,
                        })
                      }
                    />
                  </div>
                  {on && (
                    <div className="mt-2 grid gap-2 pl-0.5 sm:grid-cols-3">
                      {NOTIFY_TIERS.map((tier) => (
                        <div key={tier.key} className="flex flex-col gap-1">
                          <span className="text-[12px] text-muted-foreground">{tier.label}</span>
                          <Select
                            items={LEVEL_OPTS}
                            value={cfg[tier.key]}
                            onValueChange={(v) =>
                              saveConfig.mutate({
                                id: m.id,
                                cfg: { ...stripId(cfg), [tier.key]: v as NotifyLevel },
                              })
                            }
                          >
                            <SelectTrigger aria-label={`${tier.label} notification`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {LEVEL_OPTS.map((o) => (
                                <SelectItem key={o.value} value={o.value}>
                                  {o.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Section>
  );
}
