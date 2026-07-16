"use client";

// Minimal class error boundary for the PDF evidence viewer: if anything in the
// pdf.js pipeline throws (worker load, parse, render), we swap in the caller's
// fallback (the plain <iframe> viewer) instead of losing evidence access.

import { Component, type ReactNode } from "react";

export class PdfViewerErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
