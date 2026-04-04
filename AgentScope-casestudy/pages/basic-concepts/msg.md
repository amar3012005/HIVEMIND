---
title: "Message"
url: "https://docs.agentscope.io/basic-concepts/msg"
path: "/basic-concepts/msg"
section: "basic-concepts"
lastmod: "2026-03-30T04:05:55.760Z"
---
# Message
Source: https://agentscope-ai-786677c7.mintlify.app/basic-concepts/msg

The basic data structure in AgentScope

Message (`Msg`) is the basic data structure in AgentScope, responsible for exchanging information among agents, users, and tools.

Its basic fields include:

| Field       | Description                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------- |
| `id`        | Unique identifier for the message                                                                  |
| `name`      | The name of the message sender                                                                     |
| `role`      | The role of the message sender ("user", "assistant", "system")                                     |
| `content`   | The content of the message, which can be text, image, video, audio, tool calls, tool results, etc. |
| `timestamp` | The time when the message was created                                                              |
| `metadata`  | Additional information about the message, such as tool calls, reasoning traces, etc.               |

<Note>
  The `content` field can be a plain string for simple text messages, or a list of content blocks for multimodal and tool call messages. Each content block is a dictionary with a `type` field indicating the content type.
</Note>

**Supported content block types:**

| Type          | Example                                                                           |
| ------------- | --------------------------------------------------------------------------------- |
| `text`        | `{"type": "text", "text": "Hello AgentScope!"}`                                   |
| `thinking`    | `{"type": "thinking", "thinking": "Hmm, let me think..."}`                        |
| `image`       | `{"type": "image", "source": {"type": "url", "url": "https://xxx/image.jpg"}}`    |
| `video`       | `{"type": "video", "source": {"type": "url", "url": "https://xxx/video.mp4"}}`    |
| `audio`       | `{"type": "audio", "source": {"type": "url", "url": "https://xxx/audio.mp3"}}`    |
| `tool_use`    | `{"type": "tool_use", "id": "xxxx", "name": "search", "input": {"query": "..."}}` |
| `tool_result` | `{"type": "tool_result", "id": "xxxx", "name": "search", "output": "..."}`        |

**Quick examples:**

```python theme={null}
from agentscope.message import Msg

# A simple text message
msg = Msg(name="Friday", content="Hello, I'm your assistant!", role="assistant")

# Multimodal message
msg = Msg(
    name="Bob",
    content=[
        {"type": "text", "text": "How about this image?"},
        {"type": "image", "source": {"type": "url", "url": "https://example.com/image.jpg"}},
    ],
    role="user",
)

# Tool call message
msg = Msg(
    name="Alice",
    content=[
        {
            "type": "tool_use",
            "id": "xxxx",
            "name": "search",
            "input": {"query": "What's the weather today?"}
        }
    ],
    role="user",
)
```
