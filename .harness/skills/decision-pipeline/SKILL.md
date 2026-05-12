---
name: decision-pipeline
description: "Working with the decision engine, orchestrator, classifier, and policy engine"
triggers:
  - "bg-components/decision-engine.js modified"
  - "bg-components/decision-orchestrator.js modified"
  - "bg-components/task-classifier.js modified"
  - "bg-components/policy-engine.js modified"
  - "bg-components/event-store.js modified"
  - "task mentions recommendations, anomaly detection, budgets, or classification"
agent: decision-engineer
---

# Decision Pipeline Skill

## Context

The decision pipeline is the strategic core of the extension. It turns passive
cost tracking into active decision intelligence. The pipeline follows four stages:
Observation, Inference, Policy, Feedback.

## Key Files

- `bg-components/decision-orchestrator.js` -- unified `evaluateDecision(context)` entry point
- `bg-components/decision-engine.js` -- recommendations, anomaly detection, budgets, preview
- `bg-components/task-classifier.js` -- local rules-based prompt classification
- `bg-components/policy-engine.js` -- maps risk + recommendations to action classes
- `bg-components/event-store.js` -- request/session/user-profile state

## Architecture

```
User prompt arrives
  -> task-classifier.js: classify prompt type (summarization, coding, etc.)
  -> decision-orchestrator.js: evaluateDecision(context)
    -> decision-engine.js: cost preview, model recommendations, anomaly check, budget check
    -> policy-engine.js: determine action class
      - silent_pass: no intervention
      - passive_hint: subtle indicator
      - inline_recommendation: suggestion chip
      - confirmation_gate: user confirmation (must be dismissible!)
      - rewrite_suggestion: alternative prompt/model
  -> event-store.js: record outcome for feedback learning
```

## Step-by-Step: Modifying the Decision Pipeline

1. **Understand the flow.** Start at `evaluateDecision()` in
   decision-orchestrator.js. Trace through each stage before modifying.

2. **Preserve action class semantics.** The five action classes have specific
   UI behaviors. Do not change their meaning without updating smart_ui.js.

3. **Keep classification local.** task-classifier.js uses rules-based
   classification. No external API calls for classification.

4. **Respect fail-open.** Even `confirmation_gate` must be dismissible.
   The user must always be able to send their message.

5. **Update event recording.** If you add new decision factors, ensure
   `recordUserAction()` captures them for feedback learning.

6. **Run gates:**
   ```bash
   node --check bg-components/decision-engine.js
   node --check bg-components/decision-orchestrator.js
   node --check bg-components/task-classifier.js
   node --check bg-components/policy-engine.js
   node --check bg-components/event-store.js
   npm test
   ```

## Step-by-Step: Adding a New Decision Factor

1. Define the factor in decision-engine.js (e.g., new anomaly type).
2. Add it to the evaluateDecision() pipeline in decision-orchestrator.js.
3. Update policy-engine.js if the factor affects action class determination.
4. Update event-store.js to track the new factor in user profiles.
5. Coordinate with content-engineer if UI changes are needed in smart_ui.js.

## Non-Negotiables

- Fail-open: all decision UI must be non-blocking and dismissible
- Local-only: no external API calls in the decision pipeline
- Classification must be rules-based (no ML model inference)
