//! The libp2p half of the façade (spec 128 decisions 2 and 4; F180/F141a).
//!
//! Three modes, one wire:
//!
//! * **relay** — circuit-relay v2 rendezvous on a machine the owner controls. It terminates
//!   nothing: it accepts a reservation from a façade and splices circuits to it.
//! * **attach** — the façade. It opens **no direct listener at all**; its only listen address is
//!   `<relay>/p2p-circuit`. That is what makes the relay path forced rather than merely preferred:
//!   there is no direct address for a client to find, so the NAT path every phone will take is the
//!   only path anything here can take, on loopback, today.
//! * **probe** — a client. It dials the circuit address and asks one contract request.
//!
//! The protocol name is `red_core::LIBP2P_PROTOCOL`, which carries the contract version, so a peer
//! speaking another version fails negotiation rather than misreading a message (decision 5).
//!
//! Every mode prints one JSON object per line on stdout. The test harness reads those lines, and
//! so can a person: `{"role":"relay","peer":"12D3Koo…","listen":"/ip4/127.0.0.1/tcp/54321"}`.

use std::io;
use std::time::Duration;

use futures::{AsyncReadExt, AsyncWriteExt, StreamExt};
use libp2p::core::transport::ListenerId;
use libp2p::multiaddr::Protocol;
use libp2p::request_response::{self, ProtocolSupport};
use libp2p::swarm::{NetworkBehaviour, SwarmEvent};
use libp2p::{identify, noise, relay, tcp, yamux, Multiaddr, PeerId, Stream, StreamProtocol};
use prost::Message as _;
use red_core::pb;

use crate::host::{feed_url, Workspace};

/// A contract message is length-delimited: four bytes of big-endian length, then the bytes. The
/// cap is generous for a read surface and small enough that a wrong length is refused rather than
/// allocated.
const MAX_MESSAGE: u32 = 8 * 1024 * 1024;

fn protocol() -> StreamProtocol {
    StreamProtocol::try_from_owned(red_core::LIBP2P_PROTOCOL.to_string())
        .expect("the contract's protocol name starts with a slash")
}

/// The lifecycle ring's own protocol, versioned by the same string the rest of the contract is:
/// `/red/1/feed`. A peer speaking another version fails negotiation rather than misreading frames.
fn feed_protocol() -> StreamProtocol {
    StreamProtocol::try_from_owned(format!("{}/feed", red_core::LIBP2P_PROTOCOL))
        .expect("the contract's protocol name starts with a slash")
}

/* Every swarm event, on stderr, when RED_LINK_TRACE is set: a façade that is waiting for a
   reservation and a façade that has been refused one look identical from outside. */
fn trace<T: std::fmt::Debug>(event: &T) {
    if std::env::var_os("RED_LINK_TRACE").is_some() {
        eprintln!("red-link: {event:?}");
    }
}

fn say(line: serde_json::Value) {
    println!("{line}");
    use std::io::Write;
    let _ = std::io::stdout().flush();
}

/* ---- the codec ------------------------------------------------------------------------------ */

#[derive(Clone, Default)]
pub struct ContractCodec;

async fn read_frame<T>(io: &mut T) -> io::Result<Vec<u8>>
where
    T: futures::AsyncRead + Unpin + Send,
{
    let mut header = [0u8; 4];
    io.read_exact(&mut header).await?;
    let length = u32::from_be_bytes(header);
    if length > MAX_MESSAGE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("a {length}-byte contract message is past the {MAX_MESSAGE}-byte limit"),
        ));
    }
    let mut body = vec![0u8; length as usize];
    io.read_exact(&mut body).await?;
    Ok(body)
}

async fn write_frame<T>(io: &mut T, bytes: &[u8]) -> io::Result<()>
where
    T: futures::AsyncWrite + Unpin + Send,
{
    write_frame_open(io, bytes).await?;
    io.close().await
}

/// The same frame, without closing: request/response ends a stream, the lifecycle ring does not.
async fn write_frame_open<T>(io: &mut T, bytes: &[u8]) -> io::Result<()>
where
    T: futures::AsyncWrite + Unpin + Send,
{
    io.write_all(&(bytes.len() as u32).to_be_bytes()).await?;
    io.write_all(bytes).await?;
    io.flush().await
}

impl request_response::Codec for ContractCodec {
    type Protocol = StreamProtocol;
    type Request = pb::Request;
    type Response = pb::Response;

    async fn read_request<T>(&mut self, _: &StreamProtocol, io: &mut T) -> io::Result<pb::Request>
    where
        T: futures::AsyncRead + Unpin + Send,
    {
        let bytes = read_frame(io).await?;
        pb::Request::decode(bytes.as_slice()).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }

    async fn read_response<T>(&mut self, _: &StreamProtocol, io: &mut T) -> io::Result<pb::Response>
    where
        T: futures::AsyncRead + Unpin + Send,
    {
        let bytes = read_frame(io).await?;
        pb::Response::decode(bytes.as_slice()).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }

    async fn write_request<T>(&mut self, _: &StreamProtocol, io: &mut T, request: pb::Request) -> io::Result<()>
    where
        T: futures::AsyncWrite + Unpin + Send,
    {
        write_frame(io, &request.encode_to_vec()).await
    }

    async fn write_response<T>(&mut self, _: &StreamProtocol, io: &mut T, response: pb::Response) -> io::Result<()>
    where
        T: futures::AsyncWrite + Unpin + Send,
    {
        write_frame(io, &response.encode_to_vec()).await
    }
}

fn contract_behaviour(support: ProtocolSupport) -> request_response::Behaviour<ContractCodec> {
    request_response::Behaviour::with_codec(
        ContractCodec,
        [(protocol(), support)],
        request_response::Config::default().with_request_timeout(Duration::from_secs(30)),
    )
}

fn identity(keypair: &libp2p::identity::Keypair) -> identify::Behaviour {
    identify::Behaviour::new(identify::Config::new(
        format!("{}/{}", red_core::LIBP2P_PROTOCOL, red_core::contract_version()),
        keypair.public(),
    ))
}

/* ---- the relay ------------------------------------------------------------------------------ */

#[derive(NetworkBehaviour)]
pub struct RelayBehaviour {
    relay: relay::Behaviour,
    identify: identify::Behaviour,
}

pub async fn run_relay(listen: Multiaddr) -> Result<(), String> {
    let mut swarm = libp2p::SwarmBuilder::with_new_identity()
        .with_tokio()
        .with_tcp(tcp::Config::default(), noise::Config::new, yamux::Config::default)
        .map_err(|error| format!("the relay cannot build a TCP transport: {error}"))?
        .with_behaviour(|keypair| RelayBehaviour {
            relay: relay::Behaviour::new(keypair.public().to_peer_id(), relay::Config::default()),
            identify: identity(keypair),
        })
        .map_err(|error| format!("the relay cannot build its behaviour: {error}"))?
        .build();
    let peer = *swarm.local_peer_id();
    /* A relay advertises the hop protocol only when it believes it is reachable, and by default it
       decides that from having learned an external address — which a relay on loopback, or behind
       the owner's own NAT before anyone has told it anything, never does. Here the owner has said
       what this process is by running it, so the advertisement is stated rather than inferred.
       Without this the reservation fails as `Reservation(Unsupported)`: identify lists no hop
       protocol, and the façade concludes the relay is not one. */
    swarm.behaviour_mut().relay.set_status(Some(relay::Status::Enable));
    swarm
        .listen_on(listen.clone())
        .map_err(|error| format!("the relay cannot listen on {listen}: {error}"))?;
    loop {
        match swarm.select_next_some().await {
            SwarmEvent::NewListenAddr { address, .. } => {
                /* The address it hands out is the one it listens on: a relay that does not confirm
                   its own address gives clients one they cannot use. */
                swarm.add_external_address(address.clone());
                say(serde_json::json!({ "role": "relay", "peer": peer.to_string(), "listen": address.to_string() }));
            }
            SwarmEvent::Behaviour(RelayBehaviourEvent::Relay(relay::Event::ReservationReqAccepted { src_peer_id, .. })) => {
                say(serde_json::json!({ "event": "reservation", "peer": src_peer_id.to_string() }));
            }
            SwarmEvent::Behaviour(RelayBehaviourEvent::Relay(relay::Event::CircuitReqAccepted { src_peer_id, dst_peer_id })) => {
                say(serde_json::json!({ "event": "circuit", "src": src_peer_id.to_string(), "dst": dst_peer_id.to_string() }));
            }
            _ => {}
        }
    }
}

/* ---- the façade ----------------------------------------------------------------------------- */

#[derive(NetworkBehaviour)]
pub struct FacadeBehaviour {
    relay_client: relay::client::Behaviour,
    contract: request_response::Behaviour<ContractCodec>,
    /* The ring is a long-lived stream rather than a request and an answer: a subscriber resumes
       from its cursor and stays on the same stream for what happens next (F183). */
    streams: libp2p_stream::Behaviour,
    identify: identify::Behaviour,
}

fn kind_of(request: &pb::Request) -> &'static str {
    match request.request {
        Some(pb::request::Request::Workspace(_)) => "workspace",
        Some(pb::request::Request::Dashboard(_)) => "dashboard",
        Some(pb::request::Request::Tasks(_)) => "tasks",
        Some(pb::request::Request::Token(_)) => "token",
        Some(pb::request::Request::Agents(_)) => "agents",
        None => "unknown",
    }
}

/// Attach to a workspace and serve it through the relay. Returns only on failure: a façade is a
/// process that stays up.
pub async fn run_facade(workspace: Workspace, relay_address: Multiaddr) -> Result<(), String> {
    let mut swarm = libp2p::SwarmBuilder::with_new_identity()
        .with_tokio()
        .with_tcp(tcp::Config::default(), noise::Config::new, yamux::Config::default)
        .map_err(|error| format!("the façade cannot build a TCP transport: {error}"))?
        .with_relay_client(noise::Config::new, yamux::Config::default)
        .map_err(|error| format!("the façade cannot build a relay transport: {error}"))?
        .with_behaviour(|keypair, relay_client| FacadeBehaviour {
            relay_client,
            contract: contract_behaviour(ProtocolSupport::Inbound),
            streams: libp2p_stream::Behaviour::new(),
            identify: identity(keypair),
        })
        .map_err(|error| format!("the façade cannot build its behaviour: {error}"))?
        .build();
    let peer = *swarm.local_peer_id();

    /* The whole point: the only address this process ever listens on is a circuit through the
       relay. No TCP listener is opened, so "forbidden any direct connection" is a property of the
       façade rather than a rule the client is trusted to follow. */
    let mut incoming = swarm
        .behaviour()
        .streams
        .new_control()
        .accept(feed_protocol())
        .map_err(|error| format!("the façade cannot serve {}: {error}", feed_protocol()))?;
    {
        let workspace = workspace.clone();
        tokio::spawn(async move {
            while let Some((peer, stream)) = incoming.next().await {
                let workspace = workspace.clone();
                tokio::spawn(async move {
                    let outcome = serve_feed(&workspace, stream).await;
                    say(serde_json::json!({ "event": "feed-closed", "peer": peer.to_string(),
                        "error": outcome.err().unwrap_or_default() }));
                });
            }
        });
    }

    let circuit = relay_address.clone().with(Protocol::P2pCircuit);
    let listener: ListenerId = swarm
        .listen_on(circuit.clone())
        .map_err(|error| format!("the façade cannot reserve a circuit on {relay_address}: {error}"))?;
    say(serde_json::json!({ "role": "facade", "peer": peer.to_string(), "relay": relay_address.to_string(), "listener": format!("{listener:?}") }));

    loop {
        match swarm.select_next_some().await {
            SwarmEvent::NewListenAddr { address, .. } => {
                say(serde_json::json!({ "event": "listening", "address": address.to_string() }));
            }
            SwarmEvent::Behaviour(FacadeBehaviourEvent::Contract(request_response::Event::Message {
                peer: from,
                message: request_response::Message::Request { request, channel, .. },
                ..
            })) => {
                let kind = kind_of(&request);
                let response = workspace.answer(&request);
                let refused = matches!(response.response, Some(pb::response::Response::Error(_)));
                let _ = swarm.behaviour_mut().contract.send_response(channel, response);
                say(serde_json::json!({ "event": "answered", "peer": from.to_string(), "request": kind, "refused": refused }));
            }
            SwarmEvent::Behaviour(FacadeBehaviourEvent::Contract(request_response::Event::InboundFailure { peer: from, error, .. })) => {
                say(serde_json::json!({ "event": "inbound-failure", "peer": from.to_string(), "error": error.to_string() }));
            }
            SwarmEvent::OutgoingConnectionError { error, .. } => {
                return Err(format!("the façade cannot reach its relay: {error}"));
            }
            other => trace(&other),
        }
    }
}

/// One subscriber: read what it asks for, then pump the worker's ring at it until one of them
/// goes away. The frames are translated on the way through, so a workspace that grew a field it
/// has not told the contract about is reported here rather than delivered half-read.
async fn serve_feed(workspace: &Workspace, mut stream: Stream) -> Result<(), String> {
    let asked = read_frame(&mut stream).await.map_err(|error| format!("no subscription: {error}"))?;
    let subscribe = pb::FeedSubscribe::decode(asked.as_slice()).map_err(|error| format!("unreadable subscription: {error}"))?;
    if subscribe.root_id.is_empty() {
        return Err("the lifecycle ring is asked per project root, and this subscription named none".into());
    }
    let url = feed_url(&workspace.worker, &subscribe.root_id, subscribe.after)?;
    let (socket, _) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(|error| format!("cannot open the workspace feed: {error}"))?;
    say(serde_json::json!({ "event": "feed-open", "root": subscribe.root_id, "after": subscribe.after }));
    let (_, mut reading) = socket.split();
    while let Some(message) = reading.next().await {
        let message = message.map_err(|error| format!("the workspace feed failed: {error}"))?;
        let text = match message {
            tokio_tungstenite::tungstenite::Message::Text(text) => text.to_string(),
            tokio_tungstenite::tungstenite::Message::Close(frame) => {
                /* A retired worker closes with the reason that tells a client to re-read feed_url
                   and resume from its cursor; it is carried rather than turned into silence. */
                return Err(frame.map(|f| f.reason.to_string()).unwrap_or_else(|| "the workspace feed closed".into()));
            }
            _ => continue,
        };
        let value: serde_json::Value = serde_json::from_str(&text).map_err(|error| format!("the workspace feed sent {error}"))?;
        let (event, drift) = red_core::translate::lifecycle_event("feed", &value);
        if !drift.is_empty() {
            return Err(format!(
                "the workspace and the red.v1 contract disagree about a lifecycle frame: {}",
                drift.iter().map(|item| item.to_string()).collect::<Vec<_>>().join("; ")
            ));
        }
        write_frame_open(&mut stream, &event.encode_to_vec())
            .await
            .map_err(|error| format!("the subscriber went away: {error}"))?;
    }
    Ok(())
}

/* ---- the client ----------------------------------------------------------------------------- */

#[derive(NetworkBehaviour)]
pub struct ProbeBehaviour {
    relay_client: relay::client::Behaviour,
    contract: request_response::Behaviour<ContractCodec>,
    streams: libp2p_stream::Behaviour,
}

/// Ask the façade one question through the relay, and answer with what came back.
///
/// The address dialed is `<relay>/p2p-circuit/p2p/<façade>`; this client is given no direct
/// address and the façade has none to give, so a direct connection is not available to fall back
/// on — which is what makes this evidence about the relay path rather than about a shortcut.
pub async fn run_probe(relay_address: Multiaddr, facade: PeerId, request: pb::Request) -> Result<pb::Response, String> {
    let mut swarm = libp2p::SwarmBuilder::with_new_identity()
        .with_tokio()
        .with_tcp(tcp::Config::default(), noise::Config::new, yamux::Config::default)
        .map_err(|error| format!("the client cannot build a TCP transport: {error}"))?
        .with_relay_client(noise::Config::new, yamux::Config::default)
        .map_err(|error| format!("the client cannot build a relay transport: {error}"))?
        .with_behaviour(|_, relay_client| ProbeBehaviour {
            relay_client,
            contract: contract_behaviour(ProtocolSupport::Outbound),
            streams: libp2p_stream::Behaviour::new(),
        })
        .map_err(|error| format!("the client cannot build its behaviour: {error}"))?
        .build();

    let circuit = relay_address
        .clone()
        .with(Protocol::P2pCircuit)
        .with(Protocol::P2p(facade));
    swarm.add_peer_address(facade, circuit.clone());
    swarm
        .dial(circuit.clone())
        .map_err(|error| format!("the client cannot dial {circuit}: {error}"))?;
    let outbound = swarm.behaviour_mut().contract.send_request(&facade, request);

    let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
    loop {
        let event = tokio::time::timeout_at(deadline, swarm.select_next_some())
            .await
            .map_err(|_| format!("no answer from {facade} through {relay_address} within 45s"))?;
        match event {
            SwarmEvent::Behaviour(ProbeBehaviourEvent::Contract(request_response::Event::Message {
                message: request_response::Message::Response { request_id, response },
                ..
            })) if request_id == outbound => return Ok(response),
            SwarmEvent::Behaviour(ProbeBehaviourEvent::Contract(request_response::Event::OutboundFailure { error, .. })) => {
                return Err(format!("the request failed on the way: {error}"));
            }
            SwarmEvent::OutgoingConnectionError { error, .. } => {
                return Err(format!("the client cannot reach the façade through the relay: {error}"));
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_protocol_name_is_the_contract_version() {
        assert_eq!(protocol().as_ref(), red_core::LIBP2P_PROTOCOL);
        assert_eq!(protocol().as_ref(), format!("/red/{}", red_core::PROTOCOL_VERSION));
    }

    #[tokio::test]
    async fn a_frame_longer_than_the_cap_is_refused_rather_than_allocated() {
        let mut bytes: Vec<u8> = (MAX_MESSAGE + 1).to_be_bytes().to_vec();
        bytes.extend_from_slice(b"whatever");
        let error = read_frame(&mut futures::io::Cursor::new(bytes)).await.expect_err("refused");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("past the"), "{error}");
    }

    #[tokio::test]
    async fn a_request_survives_the_round_trip_through_the_codec() {
        let request = pb::Request {
            request: Some(pb::request::Request::Dashboard(pb::DashboardRequest { root_id: "root-1".into() })),
        };
        let mut buffer = futures::io::Cursor::new(Vec::new());
        write_frame(&mut buffer, &request.encode_to_vec()).await.unwrap();
        let bytes = buffer.into_inner();
        let read = read_frame(&mut futures::io::Cursor::new(bytes)).await.unwrap();
        assert_eq!(pb::Request::decode(read.as_slice()).unwrap(), request);
    }
}

/// Subscribe to the lifecycle ring through the relay and print `count` frames as they arrive.
///
/// The subscription is one stream: the workspace replays the ring from `after` and then keeps the
/// same stream open for what happens next, which is what makes "resumes from a cursor" and "stays
/// live" one behaviour rather than two.
pub async fn run_feed(
    relay_address: Multiaddr,
    facade: PeerId,
    root_id: String,
    after: u64,
    count: usize,
) -> Result<(), String> {
    let mut swarm = libp2p::SwarmBuilder::with_new_identity()
        .with_tokio()
        .with_tcp(tcp::Config::default(), noise::Config::new, yamux::Config::default)
        .map_err(|error| format!("the client cannot build a TCP transport: {error}"))?
        .with_relay_client(noise::Config::new, yamux::Config::default)
        .map_err(|error| format!("the client cannot build a relay transport: {error}"))?
        .with_behaviour(|_, relay_client| ProbeBehaviour {
            relay_client,
            contract: contract_behaviour(ProtocolSupport::Outbound),
            streams: libp2p_stream::Behaviour::new(),
        })
        .map_err(|error| format!("the client cannot build its behaviour: {error}"))?
        .build();

    let circuit = relay_address.clone().with(Protocol::P2pCircuit).with(Protocol::P2p(facade));
    swarm.add_peer_address(facade, circuit.clone());
    let mut control = swarm.behaviour().streams.new_control();
    /* The swarm has to keep running while the stream is open, so it is driven on its own task and
       this one owns the conversation. */
    tokio::spawn(async move {
        loop {
            let event = swarm.select_next_some().await;
            trace(&event);
        }
    });

    let mut stream = control
        .open_stream(facade, feed_protocol())
        .await
        .map_err(|error| format!("the client cannot open the lifecycle stream: {error}"))?;
    let subscribe = pb::FeedSubscribe { root_id, after };
    write_frame_open(&mut stream, &subscribe.encode_to_vec())
        .await
        .map_err(|error| format!("the subscription did not reach the façade: {error}"))?;

    for _ in 0..count {
        let bytes = read_frame(&mut stream).await.map_err(|error| format!("the lifecycle stream ended: {error}"))?;
        let event = pb::LifecycleEvent::decode(bytes.as_slice()).map_err(|error| format!("unreadable frame: {error}"))?;
        say(serde_json::to_value(&event).map_err(|error| format!("cannot render the frame: {error}"))?);
    }
    Ok(())
}
