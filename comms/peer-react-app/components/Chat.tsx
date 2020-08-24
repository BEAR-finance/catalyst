import React, { useState, useRef, useEffect } from "react";
import { IPeer } from "../../peer/src/types";
import { Button, Radio } from "decentraland-ui";
import { PeerMessageTypes } from "../../peer/src/messageTypes";
import { mouse } from "./Mouse";
import { AudioCommunicator, AudioCommunicatorChannel } from "../../peer/src/audio/AudioCommunicator";

type Message = {
  sender: string;
  content: string;
};

function MessageBubble(props: { message: Message; own?: boolean }) {
  const { sender, content } = props.message;

  const classes = ["message-bubble"];
  if (props.own) {
    classes.push("own");
  }

  return (
    <div className={classes.join(" ")}>
      <em className="sender">{sender}</em>
      <p className="content">{content}</p>
    </div>
  );
}

function CursorComponent(props: { cursor: Cursor; peerId: string }) {
  return (
    <div
      className="other-cursor"
      style={{
        left: props.cursor.x + "px",
        top: props.cursor.y + "px",
        backgroundColor: props.cursor.color,
        paddingLeft: "10px",
      }}
    >
      {props.peerId}
    </div>
  );
}

type Cursor = {
  x: number;
  y: number;
  color: string;
};

// function randomColor() {
//   return "hsl(" + Math.floor(Math.random() * 359) + ", 100%, 50%)";
// }

let intervalId: number | undefined = undefined;

let audioCommunicator: AudioCommunicator | undefined;
let mediaSource: MediaSource | undefined;
let sourceBuffer: SourceBuffer | undefined;

// let audioBuffers: Record<string, ArrayBuffer[]> = {};

export function Chat(props: { peer: IPeer; layer: string; room: string; url: string }) {
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [message, setMessage] = useState("");
  const [audioOn, setAudioOn] = useState<boolean>(false);
  const [cursors, setCursors] = useState<Record<string, Cursor>>({});
  const [updatingCursors, setUpdatingCursors] = useState(!!new URLSearchParams(location.search).get("updatingCursors"));
  const [currentRoom, setCurrentRoom] = useState(props.room);
  const [availableRooms, setAvailableRooms] = useState([]);
  const [joinedRooms, setJoinedRooms] = useState(props.peer.currentRooms);
  const [newRoomName, setNewRoomName] = useState("");
  const messagesEndRef: any = useRef();
  const audioRef = useRef<HTMLAudioElement>(null);

  document.title = props.peer.peerIdOrFail();

  props.peer.callback = (sender, room, payload, subtype) => {
    if (!joinedRooms.some((joined) => joined.id === room)) {
      return;
    }
    switch (payload.type) {
      case "chat":
        appendMessage(room, sender, payload.message);
        break;
      case "cursorPosition":
        setCursorPosition(sender, payload.position);
        break;
      default:
        if (subtype === "voice") {
          playAudio(payload);
        } else {
          console.log("Received unknown message type: " + payload.type);
        }
    }
  };

  function setCursorPosition(sender: string, position: { x: number; y: number }) {
    if (updatingCursors) {
      const cursorColor = props.peer.isConnectedTo(sender) ? "green" : "red";

      props.peer.setPeerPosition(sender, [position.x, position.y, 0]);

      setCursors({
        ...cursors,
        [sender]: { color: cursorColor, x: position.x, y: position.y },
      });
    }
  }

  function createAudioSource() {
    mediaSource = new MediaSource();

    console.log("Media source created");

    mediaSource.addEventListener("sourceclose", (ev) => {
      console.log("source ended", ev);
      setAudioUrl();
    });

    mediaSource.addEventListener("sourceopen", () => {
      console.log("Source opened");
      createSourceBuffer();
    });

    setAudioUrl();
  }

  function setAudioUrl() {
    audioRef.current!.src = URL.createObjectURL(mediaSource);
    console.log("Setted audio url");
  }

  function createSourceBuffer() {
    sourceBuffer = mediaSource!.addSourceBuffer("audio/webm;codecs=opus");
    sourceBuffer.addEventListener("error", (e) => {
      console.log("error", e);
    });
    sourceBuffer.addEventListener("abort", (e) => console.log("abort", e));
  }

  function sendCursorMessage() {
    props.peer.sendMessage(currentRoom, { type: "cursorPosition", position: { ...mouse } }, PeerMessageTypes.unreliable("cursorPosition"));
  }

  function playAudio(payload: Uint8Array) {
    if (mediaSource) {
      if (mediaSource?.readyState === "ended") {
        createAudioSource();
      } else if (mediaSource?.readyState === "open" && sourceBuffer) {
        if(!sourceBuffer.updating) {
          sourceBuffer.appendBuffer(payload);
        }
      }

      // audioRef.current?.play().catch((e) => console.log("Error in play: ", e));
    }
  }

  function sendMessage() {
    appendMessage(currentRoom, props.peer.peerIdOrFail(), message);
    props.peer.sendMessage(currentRoom, { type: "chat", message }, PeerMessageTypes.reliable("chat"));
    setMessage("");
  }

  function appendMessage(room: string, sender: string, content: string) {
    setMessages({
      ...messages,
      [room]: [...(messages[room] ?? []), { sender, content }],
    });
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    createAudioSource();
  }, []);

  useEffect(() => {
    window.clearInterval(intervalId);
    if (updatingCursors) {
      intervalId = window.setInterval(() => sendCursorMessage(), 500);
    }

    return () => window.clearInterval(intervalId);
  }, [updatingCursors]);

  useEffect(() => {
    if (audioOn) {
      audioCommunicator?.start();
    } else {
      audioCommunicator?.pause();
    }
  }, [audioOn]);

  useEffect(() => {
    setInterval(async () => {
      try {
        const response = await fetch(`${props.url}/layers/${props.layer}/rooms`);
        const rooms = await response.json();
        setAvailableRooms(rooms.filter((room) => !joinedRooms.some((joined) => joined.id === room)));
      } catch (e) {}
    }, 1000);
  }, []);

  useEffect(() => {
    navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then(
      (a) => {
        audioCommunicator = new AudioCommunicator(a, AudioCommunicatorChannel.fromPeer(props.room, props.peer));
      },
      (e) => {
        console.log("Error requesting audio: ", e);
        setAudioOn(false);
      }
    );
  }, []);

  const users = [...(joinedRooms.find((r) => r.id === currentRoom)?.users?.values() ?? [])];

  async function joinRoom(room: string) {
    try {
      await props.peer.joinRoom(room);
      setAvailableRooms(availableRooms.filter((r) => r !== room));
      setJoinedRooms(props.peer.currentRooms);

      // @ts-ignore
      Object.keys(props.peer.knownPeers).forEach((it) => {
        // @ts-ignore
        const position = { x: props.peer.knownPeers[it].position[0], y: props.peer.knownPeers[it].position[1] };
        setCursorPosition(it, position);
      });
    } catch (e) {
      console.log(`error while joining room ${room}`, e);
    }
  }

  return (
    <div className="chat">
      <audio ref={audioRef} autoPlay></audio>
      <h2 className="welcome-message">Welcome to the Chat {props.peer.peerId}</h2>
      <div className="side">
        <h3>Available rooms</h3>
        <ul className="available-rooms">
          {availableRooms.map((room, i) => (
            <li className="available-room clickable" key={`available-room-${i}`} onDoubleClick={() => joinRoom(room)}>
              {room}
            </li>
          ))}
        </ul>
      </div>
      <div className="main">
        <div className="rooms-details">
          <div className="rooms-joined">
            <h3>Rooms joined</h3>
            <ul>
              {joinedRooms.map((room, i) => (
                <li className={"room-joined" + (currentRoom === room.id ? " active-room" : "")} key={`room-joined-${i}`}>
                  <button
                    disabled={room.id === currentRoom}
                    className="action-leave-room"
                    onClick={async () => {
                      try {
                        await props.peer.leaveRoom(room.id);
                        setJoinedRooms(joinedRooms.filter((joined) => room.id !== joined.id));
                      } catch (e) {
                        console.log(`error while trying to leave room ${room.id}`, e);
                      }
                    }}
                  >
                    x
                  </button>
                  <span
                    className={room.id === currentRoom ? "" : "clickable"}
                    onClick={() => {
                      const newRoom = room.id;
                      if (newRoom !== currentRoom) {
                        setCurrentRoom(newRoom);
                      }
                    }}
                  >
                    {room.id}
                  </span>
                </li>
              ))}
            </ul>
            <div className="create-room">
              <input className="create-room-input" value={newRoomName} onChange={(event) => setNewRoomName(event.currentTarget.value)} placeholder="roomName"></input>
              <button
                className="action-create-room"
                disabled={!newRoomName}
                onClick={async () => {
                  await joinRoom(newRoomName);
                  setNewRoomName("");
                }}
              >
                +
              </button>
            </div>
          </div>
          <div className="room-users">
            <h3>Users in room</h3>
            <ul>
              {users.map((user, i) => (
                <li className="room-user" key={`room-user-${i}`}>
                  {user}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="current-room">
          <div className="room-title">
            <h3>
              Now in <i>{currentRoom}</i>
            </h3>
            <Radio toggle label="Sync cursors" checked={updatingCursors} onChange={(ev, data) => setUpdatingCursors(!!data.checked)} />
            <span style={{ marginLeft: "5px" }}>
              <Radio toggle label="Send audio" checked={audioOn} onChange={(ev, data) => setAudioOn(!!data.checked)} />
            </span>
          </div>
          <div className="messages-container">
            {messages[currentRoom]?.map((it, i) => (
              <MessageBubble message={it} key={i} own={it.sender === props.peer.peerId} />
            ))}
            <div style={{ float: "left", clear: "both" }} ref={messagesEndRef}></div>
          </div>
          <div className="message-container">
            <textarea
              value={message}
              onChange={(ev) => setMessage(ev.currentTarget.value)}
              onKeyDown={(ev) => {
                if (message && ev.keyCode === 13 && ev.ctrlKey) sendMessage();
              }}
            />
            <Button className="send" primary disabled={!message} onClick={sendMessage}>
              Send
            </Button>
          </div>
        </div>
      </div>
      {updatingCursors && Object.keys(cursors).map((it) => <CursorComponent cursor={cursors[it]} peerId={it} />)}
    </div>
  );
}
