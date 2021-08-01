/* eslint-disable @typescript-eslint/ban-ts-comment */
import { Button, Field } from 'decentraland-ui'
import React, { useEffect, useState } from 'react'
import { discretizedPositionDistance } from '../../../commons/utils/Positions'
import { Peer } from '../../peer/src'
import { util } from '../../peer/src/peerjs-server-connector/util'
import { IPeer } from '../../peer/src/types'
import { mouse } from './Mouse'
import { PeerToken } from './PeerToken'


function fieldFor(label: string, value: string, setter: (s: string) => any) {
  return <Field label={label} onChange={(ev) => setter(ev.target.value)} value={value} />
}

export const layer = 'blue'

declare const window: Window & { peer: Peer }

export function ConnectForm(props: {
  onConnected: (peer: IPeer, layer: string, room: string, url: string) => any
  peerClass: {
    new(url: string, peerId: string, callback: any, config: any): IPeer
  }
}) {
  var [nickname, setNickname] = useState('')
  var [room, setRoom] = useState('')
  var [isLoading, setLoading] = useState(false)
  var [error, setError] = useState('')

  var searchParams = new URLSearchParams(window.location.search)
  var [url, setUrl] = useState(searchParams.get('lighthouseUrl') ?? 'http://localhost:9000')

  var queryRoom = searchParams.get('room')
  var queryNickname = searchParams.get('nickname')

  async function joinRoom() {
    setError('')
    setLoading(true)
    try {
      //@ts-ignore
      const peer = (window.peer = new props.peerClass(url, undefined, () => { }, {
        token: PeerToken.getToken(nickname),
        positionConfig: {
          selfPosition: () => [mouse.x, mouse.y, 0],
          maxConnectionDistance: 3,
          distance: discretizedPositionDistance([100, 200, 400, 600, 800]),
          nearbyPeersDistance: 10,
          disconnectDistance: 5
        },
        targetConnections: 2,
        logLevel: 'DEBUG',
        maxConnections: 6,
        pingTimeout: 10000,
        pingInterval: 5000,
        optimizeNetworkInterval: 10000,
        relaySuspensionConfig: {
          relaySuspensionInterval: 750,
          relaySuspensionDuration: 5000
        },
        connectionConfig: {
          iceServers: [
            {
              urls: 'stun:stun.l.google.com:19302'
            },
            {
              urls: 'stun:stun2.l.google.com:19302'
            },
            {
              urls: 'stun:stun3.l.google.com:19302'
            },
            {
              urls: 'stun:stun4.l.google.com:19302'
            }
          ]
        },
        authHandler: (msg) => Promise.resolve(msg)
      }))
      await peer.awaitConnectionEstablished()
      await peer.setLayer(layer)
      await peer.joinRoom(room)
      setLoading(false)
      props.onConnected(peer, layer, room, url)
    } catch (e) {
      setError(e.message ?? e.toString())
      console.log(e)
      setLoading(false)
    }
  }

  useEffect(() => {
    if (searchParams.get('join')) {
      room = queryRoom ?? 'room'
      nickname = queryNickname ?? 'peer-' + util.randomToken()

      joinRoom()
    }
  }, [])

  return (
    <div className="connect-form">
      {fieldFor('URL', url, setUrl)}
      {fieldFor('Nickname', nickname, setNickname)}
      {fieldFor('Room', room, setRoom)}
      {error && <p style={{ color: 'red' }}>{error}</p>}
      <Button
        primary
        disabled={[url, nickname, room].some((it) => it === '') || isLoading}
        onClick={joinRoom}
        loading={isLoading}
      >
        Connect
      </Button>
    </div>
  )
}
