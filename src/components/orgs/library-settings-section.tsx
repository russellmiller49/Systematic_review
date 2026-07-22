"use client";

import { useEffect, useState } from "react";
import { Landmark } from "lucide-react";
import { toast } from "sonner";
import { api, apiPut, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton, Spinner } from "@/components/ui/misc";

interface LibrarySettings {
  institutionName: string | null;
  ezproxyBaseUrl: string | null;
  openUrlBaseUrl: string | null;
  updatedAt: string | null;
}

// Institutional library access (org OWNER/ADMIN editable). These settings power the
// "open via your library" links on every project's full-text queue. No credentials are
// stored — members authenticate in their own browser session.
export function LibrarySettingsSection({
  orgId,
  canManage,
}: {
  orgId: string;
  canManage: boolean;
}) {
  const [settings, setSettings] = useState<LibrarySettings | null>(null);
  const [institutionName, setInstitutionName] = useState("");
  const [ezproxyBaseUrl, setEzproxyBaseUrl] = useState("");
  const [openUrlBaseUrl, setOpenUrlBaseUrl] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<LibrarySettings>(`/api/orgs/${orgId}/library-settings`)
      .then((s) => {
        setSettings(s);
        setInstitutionName(s.institutionName ?? "");
        setEzproxyBaseUrl(s.ezproxyBaseUrl ?? "");
        setOpenUrlBaseUrl(s.openUrlBaseUrl ?? "");
      })
      .catch(() => {
        toast.error("Failed to load library settings");
        setSettings({
          institutionName: null,
          ezproxyBaseUrl: null,
          openUrlBaseUrl: null,
          updatedAt: null,
        });
      });
  }, [orgId]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const updated = await apiPut<LibrarySettings>(`/api/orgs/${orgId}/library-settings`, {
        institutionName: institutionName.trim() || null,
        ezproxyBaseUrl: ezproxyBaseUrl.trim() || null,
        openUrlBaseUrl: openUrlBaseUrl.trim() || null,
      });
      setSettings((prev) => (prev ? { ...prev, ...updated } : prev));
      toast.success("Library settings saved");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save library settings");
    } finally {
      setSaving(false);
    }
  }

  const configured =
    settings && (settings.institutionName || settings.ezproxyBaseUrl || settings.openUrlBaseUrl);

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium">Library access</h2>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Landmark className="h-4 w-4 text-muted-foreground" /> Institutional library
          </CardTitle>
          <CardDescription>
            Configure your institution&apos;s proxy and link resolver to add &quot;open via your
            library&quot; links to every full-text queue. Members sign in with their own library
            accounts — no credentials are stored here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {settings === null ? (
            <Skeleton className="h-28" />
          ) : canManage ? (
            <form onSubmit={save} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="lib-name">Institution name</Label>
                  <Input
                    id="lib-name"
                    placeholder="Demo University Library"
                    value={institutionName}
                    onChange={(e) => setInstitutionName(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lib-ezproxy">EZProxy prefix URL</Label>
                  <Input
                    id="lib-ezproxy"
                    placeholder="https://login.ezproxy.myuni.edu/login?url="
                    value={ezproxyBaseUrl}
                    onChange={(e) => setEzproxyBaseUrl(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lib-openurl">OpenURL resolver base</Label>
                  <Input
                    id="lib-openurl"
                    placeholder="https://myuni.primo.exlibrisgroup.com/openurl"
                    value={openUrlBaseUrl}
                    onChange={(e) => setOpenUrlBaseUrl(e.target.value)}
                  />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Button type="submit" size="sm" disabled={saving}>
                  {saving && <Spinner className="h-3.5 w-3.5" />} Save library settings
                </Button>
                <p className="text-xs text-muted-foreground">
                  Both URLs must be https. Ask your librarian for the exact values.
                </p>
              </div>
            </form>
          ) : configured ? (
            <div className="space-y-1 text-sm">
              {settings.institutionName && (
                <p>
                  <span className="text-muted-foreground">Institution:</span>{" "}
                  {settings.institutionName}
                </p>
              )}
              {settings.ezproxyBaseUrl && (
                <p className="truncate">
                  <span className="text-muted-foreground">EZProxy:</span> {settings.ezproxyBaseUrl}
                </p>
              )}
              {settings.openUrlBaseUrl && (
                <p className="truncate">
                  <span className="text-muted-foreground">OpenURL resolver:</span>{" "}
                  {settings.openUrlBaseUrl}
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Not configured yet — an organization owner or admin can add the institution&apos;s
              proxy details here.
            </p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
