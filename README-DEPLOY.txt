BREATHE v5.0.1 — Guided Floris van den Oever Breathwork | 5 Rounds

Self-contained static release for the existing floris-a73a3b09/flow project.
Canonical URL: https://wimhof.space/. No build command, API key, live voice
service, local Windows path or YouTube iframe is required at runtime.
Serve over HTTP(S), not file://. Deploy this entire folder together.

The canonical guide-manifest.js uses integer milliseconds. Five rounds and
150 breaths share one audio transport. Round 1 retention lasts 60,000 ms.
The existing retention progression in rounds 2–5 is preserved. Seeking and
backseeking recalculate captions, phase, circle and round completion.

Voice, breathing and background music have independently adjustable gains:
0% is silent, 100% is the delivered balance and 200% applies gain 2.0 before
the protective master stage. Chunked audio shares one AudioContext clock and
is loaded ahead to bound decoded memory. Five tuning forks remain independent.
Browsers lacking this audio route may use the clearly labelled fixed-mix
fallback; independent channel controls are unavailable in that mode.

Dutch synthetic speech uses Floris's designated ElevenLabs voice ID at its
normal speed and pitch. No subjective voice-recognition guarantee is made.
The instrumental is a continuous estimate from the original recording.
Breaths masked by original speech were reconstructed from clean fragments
of that recording. These are edited stems, not untouched isolated masters.

The supplied profile.png is byte-preserved. A separate CSS layer applies
the requested subtle tint without modifying the source face or image.

The service worker caches the complete release after a successful online
load. Wait for this download before going offline. Close old app tabs to
allow a waiting update to activate; active sessions are never taken over.

Practice sitting or lying down in a safe place. Never in/near water, under
the shower or while driving. Stop if uncomfortable. Progress follows the
recording; it is not a measurement of physical performance.

Only public runtime assets belong here. Source receipts, working stems,
private provider configuration and request logs stay outside publication.

Candidate 5.0.1: targeted interruption handling and bounded offline-cache installation.
Browser/device acceptance for this candidate is pending; see ../RELEASE_REPORT.md.
The verified 5.0.0 checkpoint is compatible only with this unchanged timeline.
An interrupted session requires a new explicit choice; a retention resumes from
the safe round start. The recovery panel can download a bounded tab-local
diagnostic record. It includes no audio, error text, URLs or network telemetry.
