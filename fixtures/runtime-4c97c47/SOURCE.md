# Immutable Runtime fixture mirror

Authority: accepted conversation-runtime-sdk commit `4c97c47c9cb044728413516c48aa86534e58523b`,
`tests/fixtures/timed-capture-v1/`. Files below are byte-identical mirrors, not a
second wire definition. Synthetic credentials/PCM only. Both language tests read
these same files; never replace them with independently authored protocol vectors.

| File | SHA256 |
| --- | --- |
| frame.json | a9512e71021033885c8ba37496e7a75351768187e9c84cf2c58c3916a5f9898e |
| recording.json | 23ae7ed7b4b1310bb9062f45aa1cfd07ba9a270bf39544d8237777095ef3e055 |
| control.json | d42a2ba732ff889cdfeabea0963d39155975ca8f26da370a91bb4834944da327 |
| metadata.json | 41d4eb58072ceaf0a6e890d322f1136b41c5a96d4b03491f1335b82bc491747b |
| output.json | cba9c1028e7d909918c9e19b9b047cd1308adea312abba9faa91ced4eaaff187 |
| README.md | 3f15c3a008cc0d13745a7543266a46da3755d0362c39e48e7d1df656b7e44ab0 |

The same revision's `docs/media-protocol-v2.md` has SHA256
`1e32ec1cf48c4f7f3bedb012e21bf3c84f92a95a7fdb092b1aceec09ec12ecd3`.
Mandatory kind9 is consumed before native startup on every socket. The earlier
2e1/9cdc preparation snapshots are superseded, not independent wire authorities.
