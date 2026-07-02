import type { EmailTemplate } from "@cfmail/shared";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Section } from "@/components/settings-ui.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { useUserPrefs } from "@/lib/prefs.ts";
import { TEMPLATE_TOKENS } from "@/lib/templates.ts";

export function TemplatesSection() {
  const { prefs, setPrefs, saving } = useUserPrefs();
  const [items, setItems] = useState<EmailTemplate[]>(prefs.templates ?? []);
  // Pending local edits guard the resync so server echoes don't clobber typing.
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setItems(prefs.templates ?? []);
  }, [prefs.templates]);

  const commit = (next: EmailTemplate[]) => {
    dirty.current = false;
    void setPrefs({ templates: next });
  };
  const editField = (id: string, patch: Partial<EmailTemplate>) => {
    dirty.current = true;
    setItems((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };
  const persist = () => {
    if (dirty.current) commit(items);
  };
  const add = () => {
    const next = [...items, { id: crypto.randomUUID(), name: "Untitled template", body: "" }];
    setItems(next);
    commit(next);
  };
  const remove = (id: string) => commit(items.filter((t) => t.id !== id));

  return (
    <Section
      id="templates"
      title="Templates"
      description="Reusable snippets you can drop into a message from the composer."
      action={
        <Button variant="outline" size="sm" onClick={add} disabled={saving}>
          <Plus className="size-3.5" /> Add template
        </Button>
      }
    >
      <p className="mb-4 text-[12px] leading-snug text-muted-foreground">
        Use placeholders in a template — they're filled in when you insert it:{" "}
        {TEMPLATE_TOKENS.map((t, i) => (
          <span key={t.token}>
            {i > 0 && ", "}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">{t.token}</code> ({t.label})
          </span>
        ))}
        .
      </p>
      {items.length === 0 ? (
        <div className="rounded-md border border-dashed px-4 py-6 text-center text-[13px] text-muted-foreground">
          No templates yet.
        </div>
      ) : (
        <div className="space-y-4">
          {items.map((t) => (
            <div key={t.id} className="rounded-md border bg-background/40 p-3">
              <div className="flex items-start gap-2">
                <Input
                  value={t.name}
                  placeholder="Template name"
                  onChange={(e) => editField(t.id, { name: e.target.value })}
                  onBlur={persist}
                  className="flex-1"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => remove(t.id)}
                  disabled={saving}
                  className="hover:bg-destructive/10 hover:text-destructive"
                  aria-label="Delete template"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              <Input
                value={t.subject ?? ""}
                placeholder="Subject (optional — fills only when empty)"
                onChange={(e) => editField(t.id, { subject: e.target.value })}
                onBlur={persist}
                className="mt-2"
              />
              <Textarea
                value={t.body}
                placeholder="Template body…"
                rows={5}
                onChange={(e) => editField(t.id, { body: e.target.value })}
                onBlur={persist}
                className="mt-2"
              />
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
