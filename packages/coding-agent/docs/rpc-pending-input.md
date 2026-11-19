# Pending input in the PiTTy fork

RPC clients can inspect, edit, cancel, and combine user input until the agent consumes it from its queue. These operations do not abort the active response and do not rewrite conversation history.

## Identity and snapshots

Supply a unique `messageId` with `prompt`, `steer`, or `follow_up`. Pi generates one if omitted. Successful responses include `data.messageId` alongside `data.disposition`. The request `id` still correlates the command response and is separate from the message identity.

```json
{"id":"send-1","type":"prompt","messageId":"input-a","message":"Check the parser","streamingBehavior":"steer"}
{"id":"send-1","type":"response","command":"prompt","success":true,"data":{"disposition":"queued","messageId":"input-a"}}
```

Send `get_queue` for the authoritative snapshot. `get_state` includes the same snapshot in `data.queue`. Every `queue_update` event includes `revision` and `messages` plus the existing `steering` and `followUp` text arrays.

```json
{
  "type":"response",
  "command":"get_queue",
  "success":true,
  "data":{
    "revision":2,
    "messages":[
      {"id":"input-a","mode":"steer","message":"Check the parser"},
      {"id":"input-b","mode":"steer","message":"Include empty input"}
    ]
  }
}
```

Each message may also contain an `images` array of `ImageContent` objects. Text is prepared content after input hooks, skill expansion, and prompt-template expansion. Steering messages appear before follow-up messages, preserving received order within each mode.

The revision increases whenever accepted pending input changes. It is local to one session runtime. Reset the client's revision when replacing the session or process.

## Edit, cancel, and combine

All three mutations return the resulting queue snapshot in `data` and emit `queue_update`. Supply the latest `expectedRevision` to reject a stale view without changing anything. The field is optional.

```json
{"id":"edit-1","type":"update_queued_message","messageId":"input-a","message":"Check the parser and its error handling","expectedRevision":2}
{"id":"cancel-1","type":"remove_queued_message","messageId":"input-b","expectedRevision":3}
```

Editing replaces prepared text exactly. It does not rerun input hooks or templates. Omit `images` to retain attachments, or send `images:[]` to remove them.

```json
{"id":"combine-1","type":"combine_queued_messages","messageIds":["input-a","input-b"],"expectedRevision":2}
```

Combining requires two or more distinct consecutive pending messages from the same mode, in queue order. The combined message keeps the first ID and queue position, joins texts with two newline characters, and retains all attachments in order. An intervening extension message also prevents combining across it.

A stale revision, unknown ID, consumed target, or invalid combination returns `success:false`. No target changes on failure. Refresh the queue before retrying, and retain any unsaved edit in the client.

## Consumption boundary

Queue removal occurs when the runtime claims input for processing, before asynchronous message events. A message can therefore stop being editable before its text appears in the conversation. This does not assert that the provider has already received it.

Once the message leaves the queue, these commands cannot cancel or alter it. Use the existing abort action to stop active work. An edit of conversation history is a separate operation.

## Compaction and concurrent sends

A normal prompt sent during manual compaction is accepted as queued. Its default mode is follow-up when `streamingBehavior` is omitted. Send the desired mode explicitly when the client's busy state may be stale.

After successful manual compaction, accepted input starts a new run. It does not resume the interrupted response. Failed or aborted manual compaction leaves accepted input queued and does not start a new run. A later prompt can start the pending work, or the client can edit or cancel it.

Automatic compaction remains part of an active run. Prompts with `streamingBehavior` queue for that run and remain editable until the runtime claims them. Prompts during branch summarization still fail because the selected conversation branch is changing.

Input preparation is serialized independently of model execution. Two submissions keep their received order even if the first has a slow input hook or authentication check. Pending input stays in memory, like the existing Pi queue; it is not persisted across process exit.


## Accepted-input extension notification

Extensions can observe `input_queued` after prepared user input has entered the
actual pending queue:

```ts
pi.on("input_queued", (event, ctx) => {
  // event: { type, messageId, message, images?, mode, source }
  // ctx.hasPendingMessages() is already true here.
});
```

The text has passed input handlers and prompt expansion. The source is
`rpc`, `interactive`, or `extension`. This notification cannot veto or
transform acceptance. It does not fire for inputs handled by an extension,
rejected submissions, immediately started prompts, or queue edits and merges.
Handlers run through the normal extension error reporting. Notification delivery
does not block the RPC acknowledgement.

An integration may use this notification to release a foreground tool wait only
after input is queued. A background-process adapter must keep the existing
process, and must verify that the foreground process belongs to the current
session.
