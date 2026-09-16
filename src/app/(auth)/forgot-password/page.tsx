"use client";

import { useState } from "react";
import Link from "next/link";
import { apiPost, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/misc";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await apiPost<{ message: string }>("/api/auth/forgot-password", { email });
      setMessage(result.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to request a reset. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{message ? "Check your email" : "Forgot password?"}</CardTitle>
        <CardDescription>We’ll email you a link to reset your Synthesis password.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {message ? <p role="status" className="text-sm">{message}</p> : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" autoComplete="email" required maxLength={320}
                value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy && <Spinner />} Send reset link
            </Button>
          </form>
        )}
        {message && <Button variant="outline" className="w-full" onClick={() => setMessage(null)}>Request another link</Button>}
        <p className="text-center text-sm"><Link href="/sign-in" className="text-primary hover:underline">Back to sign in</Link></p>
      </CardContent>
    </Card>
  );
}
