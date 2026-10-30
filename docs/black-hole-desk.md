# Black Hole desk

Open dashboard/desk/desktop.html, or serve dashboard and open /desk/.

Implemented: animated particle galaxy and orbiting selectable agent bodies; separate money accretion scene; zoom; opt-in event audio; reduced-motion preference; hidden-scene rendering suspension; context-map replay; evidence drawers; local paper accounting with configured costs and stops; browser-persistent paper state and chat messages; exports.

Authenticated POST edge-research?task=chat accepts role and message, or role and historyOnly:true. Roles: Coordinator, Scout, Filter, Analyst, Risk, Executor, Logger. Grok responds using verified server research health and dataset summaries. Successful turns are stored in private research events, scoped by credential actor and role. Last eight turns form server conversation context. Existing daily quota of 20 AI requests applies across research and chats. Tokens are never saved in browser storage. No external key is invented.

Chat commands: /evidence local role events; /history server conversation; /health; /datasets; /review DATASET_ID queues research job; /job JOB_ID reads its actual state. Chat activity animation represents current requests, not continuous autonomous workers. Coordinator offers research plans but cannot dispatch tasks. AI has no trade tools.

Paper P&L particles reflect newly closed local positions, with positive inward and negative outward motion. Initial paper bankroll is $1,000. Missing stop/trail configuration rejects entries. Imported evidence and quotes are not independently verified. Local state can be edited by browser users and is not an authoritative financial ledger.

Outstanding: independent background agents, automated venue discovery/quote feeds, live execution, live accounting, automatic coordinator handoffs, adjustable graphics quality, separate audio buses/ambient soundtrack, cinematic camera transitions, and verified statistical relationship mapping.

Validation: 31 focused Node tests pass; Deno typecheck passes; browser verified rendered overview and money page, local evidence chat and reload persistence. Production chat history endpoint returned 200. Real provider reply remains unverified until an xAI key is connected.
