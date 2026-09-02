# Meeting Agent

This is a reusable public engine; private config, pins, and schedules live in a deployment overlay. It integrates with TeamMem only through the meeting inbox, and reads team knowledge only from the rendered Team Vault.

## Status

Feasibility spike stage. The frozen bridge contract and both halves of the
Feishu bridge exist and are tested; nothing has yet been run against a real
Feishu client, and no feasibility measurement has been recorded.

```
protocols/          bridge-session/v1 JSON Schema — the normative contract
fixtures/contracts/ the frozen contract bytes both languages test against
spikes/feishu/      platform-neutral half: validator, recorder, observation
                    reducer (the reference ambiguity policy), replay harness
bridges/mac/        Swift package: accessibility observer, client adapter,
                    JSONL recorder — unit-tested against synthetic trees only
docs/feasibility/   what a human will measure; empty until they measure it
docs/HUMAN-CHECKLIST.md  steps deliberately not attempted by an agent
```

## Running the tests

```
npm test                        # TypeScript: node --test over **/*.test.ts
cd bridges/mac && swift test    # Swift: no external dependencies, no network
```
