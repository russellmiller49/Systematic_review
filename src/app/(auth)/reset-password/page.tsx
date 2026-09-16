"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiPost, apiErrorMessages } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/misc";

export default function ResetPasswordPage() {
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    function readToken() {
      const value = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
      setToken(/^[a-f0-9]{64}$/.test(value) ? value : "");
      setError(null);
      setDone(false);
      setPassword("");
      setConfirmation("");
    }
    readToken();
    window.addEventListener("hashchange", readToken);
    return () => window.removeEventListener("hashchange", readToken);
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    if (new TextEncoder().encode(password).length > 72) {
      setError("Password is too long. Use at most 72 bytes (some characters use more than one byte).");
      return;
    }
    setBusy(true);
    try {
      await apiPost("/api/auth/reset-password", { token, password });
      setDone(true);
      setPassword("");
      setConfirmation("");
      window.history.replaceState(null, "", window.location.pathname);
    } catch (err) {
      setError(apiErrorMessages(err).join(" "));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{done ? "Password updated" : "Reset your password"}</CardTitle>
        <CardDescription>{done ? "Sign in with your new password. Your other sessions have been signed out." : "Choose a new password with at least 10 characters."}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {token === null ? <p role="status" className="text-sm">Loading reset link…</p> : done ? (
          <p role="status" className="text-sm">Your password has been changed successfully.</p>
        ) : !token ? (
          <p role="alert" className="text-sm text-destructive">This reset link is missing or invalid. Please request a new link.</p>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="password">New password</Label>
              <Input id="password" type="password" autoComplete="new-password" required minLength={10} maxLength={200}
                value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirmation">Confirm new password</Label>
              <Input id="confirmation" type="password" autoComplete="new-password" required minLength={10} maxLength={200}
                value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy}>{busy && <Spinner />} Reset password</Button>
          </form>
        )}
        {!done && <p className="text-center text-sm"><Link href="/forgot-password" className="text-primary hover:underline">Request a new reset link</Link></p>}
        <p className="text-center text-sm"><Link href="/sign-in" className="text-primary hover:underline">Back to sign in</Link></p>
      </CardContent>
    </Card>
  );
}
