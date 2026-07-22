"use client";

import { createContext } from "react";
import type { CiteMapLike } from "@/lib/manuscript/cite-format";

// Supplied by ManuscriptClient; consumed by citation chip node views so every chip
// re-renders when the map (style/order) changes.
export const CiteMapContext = createContext<CiteMapLike | null>(null);
