import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Section } from "@/components/settings-ui.tsx";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { LabeledField as Field } from "@/components/ui/field.tsx";
import { Input } from "@/components/ui/input.tsx";
import { rpc, unwrap } from "@/lib/api.ts";
import { authClient } from "@/lib/auth-client.ts";
import { type MeUser, meQuery } from "@/lib/queries.ts";

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join("") || "?"
  );
}

export function ProfileSection({
  name,
  email,
  image,
  role,
}: {
  name: string;
  email: string;
  image: string;
  role?: string;
}) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  // react-doctor-disable-next-line no-derived-useState -- editable draft seeded from the prop; re-seeded via the parent's key remount when the server value changes
  const [draftName, setDraftName] = useState(name);
  // react-doctor-disable-next-line no-derived-useState -- editable draft seeded from the prop; re-seeded via the parent's key remount when the server value changes
  const [draftImage, setDraftImage] = useState(image);
  const [uploading, setUploading] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [draftEmail, setDraftEmail] = useState("");

  const dirty = draftName.trim() !== name || draftImage.trim() !== (image ?? "");

  async function onPickFile(file: File | undefined): Promise<void> {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Pick an image file");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image exceeds 5 MB");
      return;
    }
    setUploading(true);
    try {
      // Raw-body upload: bytes ride the request options (hc has no arg slot for
      // opaque bodies); path + response stay statically typed.
      const { url } = await unwrap(
        rpc.avatar.$post(undefined, {
          headers: { "content-type": file.type },
          init: { body: await file.arrayBuffer() },
        }),
      );
      setDraftImage(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  const save = useMutation({
    mutationFn: async () => {
      const nextName = draftName.trim();
      const nextImage = draftImage.trim();
      const res = await authClient.updateUser({ name: nextName, image: nextImage || undefined });
      if (res.error) throw new Error(res.error.message ?? "Failed to save");
      return { name: nextName, image: nextImage || null };
    },
    // Write into the cache directly — the session cookie cache can lag ~60s.
    onSuccess: (next) => {
      qc.setQueryData<{ user: MeUser | null }>(meQuery.queryKey, (old) =>
        old?.user ? { ...old, user: { ...old.user, ...next } } : old,
      );
      toast.success("Profile updated");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const changeEmail = useMutation({
    mutationFn: async () => {
      const next = draftEmail.trim().toLowerCase();
      const res = await authClient.changeEmail({ newEmail: next, callbackURL: "/app/settings" });
      if (res.error) throw new Error(res.error.message ?? "Failed");
      return next;
    },
    onSuccess: (next) => {
      setEmailOpen(false);
      setDraftEmail("");
      toast.success(`Confirmation link sent to ${next}`);
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const nextEmail = draftEmail.trim().toLowerCase();

  return (
    <Section id="profile" title="Profile" description="Your name and avatar, shown across the app.">
      <div className="flex items-start gap-4">
        <div className="flex flex-col items-center gap-2">
          <Avatar className="size-14 text-base">
            {draftImage.trim() && <AvatarImage src={draftImage.trim()} alt={draftName} />}
            <AvatarFallback>{initials(draftName)}</AvatarFallback>
          </Avatar>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            aria-label="Upload avatar image"
            className="hidden"
            onChange={(e) => {
              void onPickFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <div className="flex flex-col items-center gap-1 text-[12px]">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="font-medium text-primary hover:underline disabled:opacity-50"
            >
              {uploading ? "Uploading…" : draftImage.trim() ? "Change" : "Upload"}
            </button>
            {draftImage.trim() && (
              <button
                type="button"
                onClick={() => setDraftImage("")}
                disabled={uploading}
                className="text-muted-foreground hover:underline disabled:opacity-50"
              >
                Remove
              </button>
            )}
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-4">
          <Field label="Name" htmlFor="profile-name">
            <Input
              id="profile-name"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              maxLength={120}
            />
          </Field>
          <dl className="grid grid-cols-[72px_1fr] items-center gap-y-2 text-[13px]">
            <dt className="text-[12px] text-muted-foreground">Email</dt>
            <dd className="flex min-w-0 items-center gap-2">
              <span className="truncate">{email}</span>
              <button
                type="button"
                onClick={() => setEmailOpen((v) => !v)}
                className="shrink-0 text-[12px] font-medium text-primary hover:underline"
              >
                {emailOpen ? "Cancel" : "Change"}
              </button>
            </dd>
            <dt className="text-[12px] text-muted-foreground">Role</dt>
            <dd>
              <Badge variant="outline" className="uppercase tracking-wider">
                {role ?? "—"}
              </Badge>
            </dd>
          </dl>
          {emailOpen && (
            <div className="space-y-1.5">
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  type="email"
                  placeholder="New email address"
                  value={draftEmail}
                  onChange={(e) => setDraftEmail(e.target.value)}
                  className="flex-1"
                  autoComplete="email"
                />
                <Button
                  variant="primary"
                  onClick={() => changeEmail.mutate()}
                  disabled={
                    !nextEmail.includes("@") || nextEmail === email || changeEmail.isPending
                  }
                >
                  Send confirmation
                </Button>
              </div>
              <p className="text-[12px] text-muted-foreground">
                A confirmation link goes to the new address; your sign-in email changes once you
                open it.
              </p>
            </div>
          )}
          <Button
            variant="primary"
            onClick={() => save.mutate()}
            disabled={!dirty || !draftName.trim() || save.isPending}
          >
            Save profile
          </Button>
        </div>
      </div>
    </Section>
  );
}
