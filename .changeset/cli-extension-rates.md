---
'@solana/mosaic-cli': patch
---

`inspect-mint` now formats on-chain extension rates: basis points as `250 bps (2.50%)`, timestamps as ISO dates (`0 (not scheduled)` when unset), transfer-fee amounts with their decimal-adjusted value, and the older transfer fee on one line. The Compliance section adds Transfer Fee, Interest Rate and Scheduled Multiplier summary lines.
