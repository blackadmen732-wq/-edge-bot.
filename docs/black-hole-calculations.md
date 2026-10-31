# Black Hole Calculations — private mathematics laboratory

Added to the existing PARALLAX desk under its own navigation section, **Black Hole · Calculations**. Also accessible from the immersive workflow toolbar. This is additive to PR #5, which is stacked on the unmerged research PR #3.

## What the Instagram screen recordings illustrate

The three supplied screen recordings visually demonstrate:
- 10:14 PM — prediction error, squared loss, gradients and gradient-descent weight updates, a network trained by correcting numerical errors.
- 10:22 PM — weighted sums in neural layers and scaled dot-product attention/softmax in transformer-style architectures.
- 10:37 PM — action candidates, optimization costs and selecting an action in a model-predictive-control style loop.

The source videos are illustrative; they do not show proof of a profitable financial model or a working cosmic computer.

## What was actually implemented

- \`dashboard/desk/calculations.mjs\` — responsive calculation UI using the existing reference image \`assets/core.jpg\`, animated orbital effects, computed charts and exact equation steps.
- \`dashboard/desk/math-core.mjs\` — deterministic pure math functions with input validation.
- \`dashboard/desk/index.html\` and \`workflow.mjs\` — new sidebar + cinematic-workflow navigation.
- \`dashboard/desk/app.mjs\` — mounts the module and preserves the existing pages.
- \`dashboard/desk/style.css\` — responsive math lab styling; respects reduced-motion settings.
- \`tests/black-hole-calculations.test.mjs\` — validations and mathematical invariants.

Four modes:
1. **Patterns:** compare last positive numeric observation with previous up to 20 observations. Calculate previous-window mean and population standard deviation, z-score where defined, last percent change, percent-return dispersion, and breakout versus prior min/max. Data is entered manually or loaded from CSV with a \`value\` column.
2. **Neural learning:** one *linear* neuron \`ŷ=wx+b\`. Minimize \`L=½(ŷ−y)²\`. Calculate derivatives \`∂L/∂w=(ŷ−y)x\`, \`∂L/∂b=(ŷ−y)\`; update \`w' = w−η∂L/∂w\` and \`b'=b−η∂L/∂b\`. Shows loss before/after on the same example. This is NOT a multi-layer AI model.
3. **Attention:** given a query vector, matching key vectors and scalar values, compute \`softmax((q·kᵢ)/√d)\` (using max subtraction for numerical stability) and weighted sum \`Σ αᵢvᵢ\`. This demonstrates attention math, not a trained transformer.
4. **Decision planning:** test actions −2 to +2 with one-step transition \`x_next=x+a\`; choose minimum \`(x_next−goal)²+λa²\`. This is a toy receding-horizon control demonstration, not a full MPC optimizer, and absolutely not a live trader.

## How cloud data connects to the calculation section

The current screen uses **local, explicitly supplied** values. It NEVER automatically reads a Supabase secret, connects to brokers, sends a transaction, or stores a trained model.

Existing related data path, when separately configured/deployed:

\`\`\`text
Market / other trusted provider
   → source adapter (timestamp, provenance, availability time)
   → Supabase research observations
   → immutable dataset snapshots / version IDs
   → analysis tool (bounded numerical patterns, or future ML worker)
   → model/experiment registry and evidence
   → Parallax Data Universe read-only graph
\`\`\`

The button **Open connected Data Universe** navigates to the existing Parallax page, whose authenticated research APIs are developed in PR #5. Full automatic fetching of time series into the Black Hole Calculations UI and persistent result storage remain future work. Never claim this is running live before deployment, account authorization, and tests.

## Verification

Node.js 24+:
\`\`\`bash
node --test tests/black-hole-calculations.test.mjs tests/parallax-patterns.test.ts tests/research.test.ts
\`\`\`
Additionally verify \`dashboard/desk/calculations.mjs\` JS syntax; open the existing \`dashboard/desk/index.html\` using a local web server and visually test tabs, sample math, import, mobile layout, and reduced motion. Confirm the existing page routing and context scene still work.

This project is private, draft-only, and is NOT deployed to a production service. The actual pattern analysis backend / repository drift must be resolved separately.
