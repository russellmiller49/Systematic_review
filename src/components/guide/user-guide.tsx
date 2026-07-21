"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  BookOpenCheck,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  Download,
  FileSearch,
  FileText,
  FileUp,
  GitMerge,
  Keyboard,
  ListChecks,
  PlayCircle,
  Search,
  ShieldCheck,
  Sparkles,
  Table2,
  TrendingUp,
  Users,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { guideFaqs, guideRoles, guideSteps, updatedVideoChapters } from "@/content/user-guide";

const PHASE_STYLES: Record<string, string> = {
  Plan: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  Find: "bg-sky-50 text-sky-700 ring-sky-200",
  Decide: "bg-amber-50 text-amber-700 ring-amber-200",
  Extract: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  Synthesize: "bg-violet-50 text-violet-700 ring-violet-200",
  Report: "bg-rose-50 text-rose-700 ring-rose-200",
};

const STEP_ICONS: Record<string, LucideIcon> = {
  "create-project": Users,
  protocol: ClipboardCheck,
  import: FileUp,
  deduplication: GitMerge,
  screening: ListChecks,
  "full-text": FileSearch,
  extraction: Table2,
  "risk-of-bias": ShieldCheck,
  analysis: TrendingUp,
  grade: Sparkles,
  reporting: BarChart3,
};

const SHORTCUTS = [
  { key: "I", action: "Include", tone: "bg-emerald-600 text-white" },
  { key: "E", action: "Exclude", tone: "bg-rose-600 text-white" },
  { key: "M", action: "Maybe", tone: "bg-amber-500 text-white" },
  { key: "N", action: "Open or close note", tone: "bg-slate-100 text-slate-800" },
  { key: "J / →", action: "Skip to next citation", tone: "bg-slate-100 text-slate-800" },
  { key: "?", action: "Show shortcuts", tone: "bg-indigo-50 text-indigo-700" },
] as const;

function PhasePill({ phase }: { phase: string }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ring-1 ring-inset",
        PHASE_STYLES[phase] ?? "bg-slate-100 text-slate-700 ring-slate-200",
      )}
    >
      {phase}
    </span>
  );
}

export function UserGuide() {
  const [query, setQuery] = useState("");
  const [phase, setPhase] = useState("All");

  const filteredSteps = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return guideSteps.filter((step) => {
      if (phase !== "All" && step.phase !== phase) return false;
      if (!normalized) return true;
      return [step.title, step.summary, step.phase, ...step.actions, step.remember ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(normalized);
    });
  }, [phase, query]);

  return (
    <div className="min-h-screen bg-[#f8fafc] text-slate-950">
      <header className="sticky top-0 z-50 border-b border-slate-200/80 bg-white/90 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-5 lg:px-8">
          <Link href="/" className="flex items-center gap-2.5 text-indigo-600">
            <BookOpenCheck className="h-5 w-5" />
            <span className="font-semibold tracking-tight">Synthesis</span>
            <span className="hidden h-4 w-px bg-slate-200 sm:block" />
            <span className="hidden text-sm font-normal text-slate-500 sm:block">User guide</span>
          </Link>
          <nav className="hidden items-center gap-6 text-sm text-slate-600 md:flex" aria-label="Guide">
            <a href="#overview-video" className="hover:text-slate-950">Overview</a>
            <a href="#workflow" className="hover:text-slate-950">Workflow</a>
            <a href="#roles" className="hover:text-slate-950">Roles</a>
            <a href="#help" className="hover:text-slate-950">Help</a>
          </nav>
          <Link href="/orgs" className={cn(buttonVariants({ size: "sm" }), "rounded-full px-4")}>
            Open workspace <ArrowRight />
          </Link>
        </div>
      </header>

      <main>
        <section className="relative overflow-hidden border-b border-slate-200 bg-white">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_80%_20%,rgba(99,102,241,0.13),transparent_32%),radial-gradient(circle_at_20%_85%,rgba(14,165,233,0.10),transparent_30%)]" />
          <div className="relative mx-auto grid max-w-7xl items-center gap-12 px-5 py-16 lg:grid-cols-[1.05fr_0.95fr] lg:px-8 lg:py-24">
            <div>
              <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-indigo-100 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700">
                <Sparkles className="h-3.5 w-3.5" />
                SYSTEMATIC REVIEW, END TO END
              </div>
              <h1 className="max-w-3xl text-4xl font-semibold tracking-[-0.035em] text-slate-950 sm:text-5xl lg:text-6xl">
                From research question to defensible conclusion.
              </h1>
              <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-600">
                Learn the Synthesis workflow, understand each team role, and keep every decision
                connected to its source evidence and audit history.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <a href="#overview-video" className={cn(buttonVariants({ size: "lg" }), "rounded-full px-6")}>
                  <PlayCircle /> Watch the overview
                </a>
                <a
                  href="#workflow"
                  className={cn(buttonVariants({ size: "lg", variant: "outline" }), "rounded-full bg-white px-6")}
                >
                  Follow the workflow
                </a>
              </div>
              <div className="mt-10 grid max-w-2xl grid-cols-3 divide-x divide-slate-200 border-y border-slate-200 py-4">
                <div className="pr-4">
                  <p className="text-2xl font-semibold">12</p>
                  <p className="text-xs text-slate-500">connected workspaces</p>
                </div>
                <div className="px-4">
                  <p className="text-2xl font-semibold">8</p>
                  <p className="text-xs text-slate-500">specialized roles</p>
                </div>
                <div className="pl-4">
                  <p className="text-2xl font-semibold">1</p>
                  <p className="text-xs text-slate-500">traceable evidence chain</p>
                </div>
              </div>
            </div>

            <div className="relative mx-auto w-full max-w-xl">
              <div className="absolute -inset-5 rotate-2 rounded-[2rem] bg-indigo-100/70" />
              <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-indigo-950/10">
                <div className="flex items-center gap-1.5 border-b border-slate-200 px-4 py-3">
                  <span className="h-2.5 w-2.5 rounded-full bg-rose-300" />
                  <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-300" />
                  <span className="ml-3 text-[11px] text-slate-400">A review in motion</span>
                </div>
                <div className="space-y-5 p-5 sm:p-7">
                  {[
                    ["Plan", "Protocol v1 published", "100%"],
                    ["Decide", "36 of 36 screening decisions", "100%"],
                    ["Extract", "4 forms · 4 complete", "100%"],
                    ["Synthesize", "2 studies pooled · Moderate certainty", "82%"],
                  ].map(([label, text, width], index) => (
                    <div key={label} className="space-y-2">
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="font-medium">{text}</span>
                        <span className="text-xs text-slate-400">0{index + 1}</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                        <div className="h-full rounded-full bg-indigo-500" style={{ width }} />
                      </div>
                      <p className="text-[11px] uppercase tracking-[0.16em] text-slate-400">{label}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="overview-video" className="scroll-mt-24 border-b border-slate-200 bg-slate-950 text-white">
          <div className="mx-auto max-w-7xl px-5 py-16 lg:px-8 lg:py-20">
            <div className="grid gap-10 lg:grid-cols-[0.7fr_1.3fr] lg:items-end">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Video overview</p>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
                  See the complete review in about five minutes.
                </h2>
                <p className="mt-4 leading-7 text-slate-300">
                  A narrated tour of the real seeded workspace—from a versioned protocol to
                  PRISMA, GRADE, optional AI assistance, and the audit trail.
                </p>
                <div className="mt-6 flex flex-wrap gap-2 text-xs text-slate-300">
                  <span className="rounded-full border border-slate-700 px-3 py-1.5">English captions</span>
                  <span className="rounded-full border border-slate-700 px-3 py-1.5">Full transcript</span>
                  <span className="rounded-full border border-slate-700 px-3 py-1.5">Actual product UI</span>
                </div>
              </div>
              <div className="overflow-hidden rounded-2xl border border-white/10 bg-black shadow-2xl shadow-black/30">
                <video
                  className="aspect-[79/40] w-full bg-black object-contain"
                  controls
                  preload="metadata"
                  poster="/guide/updated_overview_stabilized-poster.jpg"
                  aria-label="Synthesis systematic review software overview"
                >
                  <source src="/guide/updated_overview_stabilized.mp4" type="video/mp4" />
                  <track
                    kind="captions"
                    src="/guide/updated_overview_stabilized.en.vtt"
                    srcLang="en"
                    label="English"
                    default
                  />
                  <track
                    kind="chapters"
                    src="/guide/updated_overview_stabilized.chapters.vtt"
                    srcLang="en"
                    label="Chapters"
                  />
                  Your browser does not support embedded video. You can download the overview below.
                </video>
              </div>
            </div>
            <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border-t border-slate-800 pt-6">
              <p className="text-sm text-slate-400">Prefer to watch offline?</p>
              <a
                href="/guide/updated_overview_stabilized.mp4"
                download
                className="inline-flex items-center gap-2 text-sm font-medium text-indigo-300 hover:text-indigo-200"
              >
                <Download className="h-4 w-4" /> Download MP4
              </a>
            </div>
            <details className="mt-6 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
              <summary className="cursor-pointer font-medium text-slate-100">Read the video transcript</summary>
              <div className="mt-5 grid gap-5 text-sm leading-7 text-slate-300 md:grid-cols-2">
                {updatedVideoChapters.map((chapter) => (
                  <div key={`${chapter.label}-${chapter.title}`}>
                    <p className="text-xs font-semibold uppercase tracking-[0.15em] text-indigo-300">{chapter.label}</p>
                    <p className="mt-1 font-medium text-white">{chapter.title}</p>
                    <p className="mt-1">{chapter.narration}</p>
                  </div>
                ))}
              </div>
            </details>
          </div>
        </section>

        <section className="border-b border-slate-200 bg-white">
          <div className="mx-auto max-w-7xl px-5 py-14 lg:px-8">
            <div className="mb-8 max-w-2xl">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">The mental model</p>
              <h2 className="mt-2 text-3xl font-semibold tracking-tight">One evidence chain, six phases.</h2>
              <p className="mt-3 text-slate-600">
                Each workspace feeds the next. Final reports are computed from the same settled
                decisions, adjudicated values, and source-linked judgments your team created.
              </p>
            </div>
            <div className="grid overflow-hidden rounded-2xl border border-slate-200 md:grid-cols-3 xl:grid-cols-6">
              {[
                ["01", "Plan", "Protocol"],
                ["02", "Find", "Import + dedup"],
                ["03", "Decide", "Screening"],
                ["04", "Extract", "Data + RoB"],
                ["05", "Synthesize", "Analysis + GRADE"],
                ["06", "Report", "PRISMA + audit"],
              ].map(([number, label, detail], index) => (
                <div key={label} className="relative border-b border-slate-200 p-5 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0">
                  <p className="font-mono text-xs text-slate-400">{number}</p>
                  <p className="mt-8 font-semibold">{label}</p>
                  <p className="mt-1 text-sm text-slate-500">{detail}</p>
                  {index < 5 && <ChevronRight className="absolute -right-3 top-1/2 z-10 hidden h-6 w-6 -translate-y-1/2 rounded-full border border-slate-200 bg-white p-1 text-slate-400 xl:block" />}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="workflow" className="scroll-mt-20">
          <div className="mx-auto max-w-7xl px-5 py-16 lg:px-8 lg:py-20">
            <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
              <div className="max-w-2xl">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Task guide</p>
                <h2 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Follow the review workflow.</h2>
                <p className="mt-3 text-slate-600">Search by task or focus on one phase. Open any chapter for the practical sequence and the rule worth remembering.</p>
              </div>
              <div className="flex w-full max-w-xl flex-col gap-3 sm:flex-row">
                <label className="relative flex-1">
                  <span className="sr-only">Search the user guide</span>
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search tasks, features, or rules…"
                    className="h-11 w-full rounded-xl border border-slate-300 bg-white pl-10 pr-4 text-sm outline-none transition focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100"
                  />
                </label>
                <label>
                  <span className="sr-only">Filter by phase</span>
                  <select
                    value={phase}
                    onChange={(event) => setPhase(event.target.value)}
                    className="h-11 rounded-xl border border-slate-300 bg-white px-4 text-sm outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100"
                  >
                    {["All", "Plan", "Find", "Decide", "Extract", "Synthesize", "Report"].map((value) => (
                      <option key={value} value={value}>{value === "All" ? "All phases" : value}</option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            <p className="mt-8 text-sm text-slate-500" aria-live="polite">
              {filteredSteps.length} {filteredSteps.length === 1 ? "chapter" : "chapters"}
            </p>
            <div className="mt-4 space-y-4">
              {filteredSteps.map((step) => {
                const Icon = STEP_ICONS[step.id] ?? FileText;
                return (
                  <details key={step.id} id={step.id} className="group scroll-mt-24 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm open:shadow-lg open:shadow-slate-200/50">
                    <summary className="grid cursor-pointer list-none items-center gap-4 p-5 marker:hidden sm:grid-cols-[56px_1fr_auto] sm:p-6">
                      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-950 text-white">
                        <Icon className="h-5 w-5" />
                      </div>
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs text-slate-400">{step.number}</span>
                          <PhasePill phase={step.phase} />
                        </div>
                        <h3 className="mt-2 text-xl font-semibold tracking-tight">{step.title}</h3>
                        <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">{step.summary}</p>
                      </div>
                      <div className="hidden h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition group-open:rotate-90 group-open:border-indigo-200 group-open:bg-indigo-50 group-open:text-indigo-600 sm:flex">
                        <ChevronRight className="h-4 w-4" />
                      </div>
                    </summary>
                    <div className="grid border-t border-slate-200 lg:grid-cols-[1fr_0.85fr]">
                      <div className="p-6 sm:p-8">
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Do this</p>
                        <ol className="mt-5 space-y-4">
                          {step.actions.map((action, index) => (
                            <li key={action} className="flex gap-3 text-sm leading-6 text-slate-700">
                              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-50 font-mono text-[11px] font-semibold text-indigo-700">{index + 1}</span>
                              <span>{action}</span>
                            </li>
                          ))}
                        </ol>
                        {step.remember && (
                          <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
                            <span className="font-semibold">Remember:</span> {step.remember}
                          </div>
                        )}
                      </div>
                      {step.image && (
                        <div className="min-h-72 border-t border-slate-200 bg-slate-100 p-4 lg:border-l lg:border-t-0">
                          <div className="h-full overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                            {/* Deliberately cropped to the working area; the full UI appears in the video. */}
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={step.image} alt={`${step.title} workspace in Synthesis`} className="h-full min-h-72 w-full object-cover object-top" loading="lazy" />
                          </div>
                        </div>
                      )}
                    </div>
                  </details>
                );
              })}
              {filteredSteps.length === 0 && (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center">
                  <Search className="mx-auto h-8 w-8 text-slate-300" />
                  <p className="mt-3 font-medium">No matching guide chapters</p>
                  <button type="button" onClick={() => { setQuery(""); setPhase("All"); }} className="mt-2 text-sm font-medium text-indigo-600 hover:underline">Clear the search</button>
                </div>
              )}
            </div>
          </div>
        </section>

        <section id="roles" className="scroll-mt-20 border-y border-slate-200 bg-white">
          <div className="mx-auto max-w-7xl px-5 py-16 lg:px-8 lg:py-20">
            <div className="grid gap-10 lg:grid-cols-[0.65fr_1.35fr]">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Team access</p>
                <h2 className="mt-2 text-3xl font-semibold tracking-tight">Give each person the right lane.</h2>
                <p className="mt-4 leading-7 text-slate-600">Roles are cumulative and capability-based. An Extractor can also be a Reviewer; a Statistician can also be an Admin.</p>
                <div className="mt-6 rounded-2xl bg-slate-950 p-5 text-sm leading-6 text-slate-300">
                  <div className="flex items-center gap-2 font-medium text-white"><ShieldCheck className="h-4 w-4 text-indigo-300" /> Blinding is enforced server-side</div>
                  <p className="mt-2">Hiding a button is not the security boundary. Reads, exports, and audit events are filtered by the caller's current capabilities.</p>
                </div>
              </div>
              <div className="overflow-hidden rounded-2xl border border-slate-200">
                <div className="hidden grid-cols-[0.65fr_0.95fr_1.4fr] gap-4 bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 sm:grid">
                  <span>Role</span><span>Best for</span><span>Access at a glance</span>
                </div>
                {guideRoles.map((item) => (
                  <div key={item.role} className="grid gap-2 border-t border-slate-200 px-5 py-4 first:border-t-0 sm:grid-cols-[0.65fr_0.95fr_1.4fr] sm:gap-4">
                    <p className="font-semibold text-slate-950">{item.role}</p>
                    <p className="text-sm text-slate-600">{item.bestFor}</p>
                    <p className="text-sm leading-6 text-slate-600">{item.access}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="bg-slate-950 text-white">
          <div className="mx-auto grid max-w-7xl gap-12 px-5 py-16 lg:grid-cols-2 lg:px-8 lg:py-20">
            <div>
              <div className="flex items-center gap-2 text-indigo-300"><Keyboard className="h-5 w-5" /><span className="text-xs font-semibold uppercase tracking-[0.2em]">Screening shortcuts</span></div>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight">Keep your hands on the keyboard.</h2>
              <p className="mt-3 text-slate-300">Shortcuts are ignored while you type in a field. Press ? in the screening queue whenever you need the reminder.</p>
              <div className="mt-8 grid gap-3 sm:grid-cols-2">
                {SHORTCUTS.map((shortcut) => (
                  <div key={shortcut.key} className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900 p-3">
                    <kbd className={cn("min-w-11 rounded-lg px-2 py-2 text-center font-mono text-xs font-semibold", shortcut.tone)}>{shortcut.key}</kbd>
                    <span className="text-sm text-slate-200">{shortcut.action}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300">Before you advance</p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight">Five quality checkpoints.</h2>
              <div className="mt-8 space-y-4">
                {[
                  "Publish the protocol and configure full-text exclusion reasons before screening.",
                  "Resolve duplicates before assigning citations to reviewers.",
                  "Settle extraction and risk-of-bias conflicts before treating results as final.",
                  "Inspect every excluded or incomplete analysis row; nothing is silently dropped.",
                  "Refresh stale GRADE assessments and freeze a PRISMA snapshot for each submission.",
                ].map((item) => (
                  <div key={item} className="flex gap-3 text-sm leading-6 text-slate-300"><CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" /><span>{item}</span></div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section id="help" className="scroll-mt-20">
          <div className="mx-auto max-w-5xl px-5 py-16 lg:px-8 lg:py-20">
            <div className="text-center">
              <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-100 text-indigo-700"><CircleHelp className="h-5 w-5" /></div>
              <h2 className="mt-4 text-3xl font-semibold tracking-tight">Common questions</h2>
              <p className="mx-auto mt-3 max-w-2xl text-slate-600">Most apparent dead ends are deliberate safeguards around roles, lifecycle locks, blinding, or incomplete evidence.</p>
            </div>
            <div className="mt-10 divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200 bg-white">
              {guideFaqs.map((faq) => (
                <details key={faq.question} className="group p-5 sm:p-6">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold marker:hidden">
                    {faq.question}
                    <ChevronRight className="h-4 w-4 shrink-0 text-slate-400 transition group-open:rotate-90" />
                  </summary>
                  <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600">{faq.answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-slate-200 bg-white">
          <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-8 px-5 py-14 lg:flex-row lg:items-center lg:px-8">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Ready when your team is</p>
              <h2 className="mt-2 text-3xl font-semibold tracking-tight">Start with the protocol. Let the evidence chain grow from there.</h2>
            </div>
            <Link href="/orgs" className={cn(buttonVariants({ size: "lg" }), "rounded-full px-6")}>
              Open Synthesis <ArrowRight />
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200 bg-[#f8fafc]">
        <div className="mx-auto flex max-w-7xl flex-col justify-between gap-4 px-5 py-8 text-sm text-slate-500 sm:flex-row sm:items-center lg:px-8">
          <div className="flex items-center gap-2"><BookOpenCheck className="h-4 w-4 text-indigo-500" /><span>Synthesis user guide</span></div>
          <p>Human decisions remain human-authored. Every final result stays traceable.</p>
        </div>
      </footer>
    </div>
  );
}
