# Same Slate game system

## Round lifecycle

Lobby → Answering → Automatic reveal / round recap → Host starts next round → Finale.

The host begins with 2–32 contestants. Team selection is required when team mode is enabled. The initial lobby readiness indicator remains a courtesy; it does not gate the host's start. There is no between-round player readiness step.

Players lock one answer. The app writes the text to the private answer path and only a submission status to the room. The host reads the private submissions once everyone has submitted, or after the timer expires. A transaction publishes the answers, groups normalized values, calculates points, adds scores and marks the round finalized. Retried reveal/finalization never doubles points. A transaction also prevents two host tabs from replacing a newly opened round.

Only other players count as matches. In `one` mode any group of at least two earns 1 each. In `matches` mode a group of size n earns n−1 each. A maximum-size group earns 31 each. Missing answers always earn zero. The highest positive round score grants a round win, including ties.

Each game snapshots the selected cards so future edits do not change past rounds. The queue avoids recent cards when possible and never repeats a prompt within the same game. Custom submissions support either orientation.

## Records

Finished games update `sameSlatePlayerStats` through per-player transactions keyed by game ID. Repeated synchronization replaces the same contribution. Master game deletion removes its room/code/history/private submissions and recalculates derived records. Google Feud stats remain in their existing paths. A player card reads both sets by the shared profile ID.

## Messages

`mailboxes/{profileId}/{messageId}` stores separate sender/recipient copies. Writes use one atomic update, server timestamps, a 2,000-character limit and validated sender identity. Each player can read only their mailbox, reply to received messages, mark received messages read, and delete their own copy. Master role does not grant mailbox reading. This preserves the existing family-trust identity model; email ownership is not verified.
