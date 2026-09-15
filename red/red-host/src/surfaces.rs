//! The game surface transport (F155/F189, spec 142): `server/surfaces.mjs` in Rust.
//!
//! A game process is a stranger. It connects to a loopback port this door opened, greets with a
//! token this door minted, and then writes frames at speed. Everything here is shaped by that:
//!
//! - **A reservation comes before the game does.** `reserve()` mints a token and hands back the two
//!   environment variables the launch puts in the game's environment. The game connects afterwards
//!   and names that token, so an unreserved token is a stranger and is dropped.
//! - **One producer per channel.** A second FRAME or INPUT socket for a token is destroyed rather
//!   than multiplexed: the token names one game, and two producers on one token is the failure
//!   `games.mjs`'s cooperative-injection note exists to prevent.
//! - **A greeting is bounded.** 100 bytes without a newline and the connection is dropped, so a
//!   producer cannot make this door hold a growing buffer by never finishing a line. The same
//!   three-second timeout covers the greeting and is cleared once the channel is known — a game
//!   that has connected properly may then be silent for as long as it likes.
//!
//! **Focus eviction is preserved verbatim** (F189 criterion 2). A focus-gain from a viewer that is
//! not the owner releases the previous owner's input FIRST and then takes ownership; a non-owner's
//! input is dropped SILENTLY rather than refused. Both halves are the semantic: the eviction is what
//! lets a person click into a game another pane holds, and the silence is what stops a viewer that
//! is not focused from learning anything about one that is.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use red_core::surface::{frame_header, greeting, Channel, Decoder, GREETING_LIMIT};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc::UnboundedSender;

/// What a viewer is sent: a JSON status line, or the bytes of a frame.
#[derive(Debug, Clone, PartialEq)]
pub enum ToViewer {
    Text(String),
    Binary(Vec<u8>),
}

/// One viewer of one surface — a `/surface` WebSocket, identified by a number so the eviction can
/// name an owner without holding its socket.
pub type ViewerId = u64;

/// A reserved surface: what the door knows about one game between the reservation and the exit.
#[derive(Default)]
pub struct Item {
    pub token: String,
    /// The pane this surface belongs to, once the launch has one.
    pub session: Option<String>,
    pub frame_count: u64,
    pub width: u32,
    pub height: u32,
    /// The most recent frame, ready to hand to a viewer that has just attached — without it a
    /// person attaching to a running game sees nothing until the next frame arrives.
    pub latest: Option<Vec<u8>>,
    pub viewers: HashMap<ViewerId, UnboundedSender<ToViewer>>,
    pub owner: Option<ViewerId>,
    /// Set while a producer holds the channel. The sender is how the door writes input to it.
    pub frames_connected: bool,
    pub input: Option<UnboundedSender<Vec<u8>>>,
}

impl Item {
    /// The three words this surface can be in, and which one it is: exactly the JavaScript's.
    pub fn status(&self) -> &'static str {
        match (self.frames_connected, self.input.is_some()) {
            (true, true) => "Live",
            (true, false) => "Input disconnected",
            _ => "Video disconnected",
        }
    }

    fn status_message(&self) -> String {
        format!(
            r#"{{"type":"surface","status":"{}","frameCount":{}}}"#,
            self.status(),
            self.frame_count
        )
    }

    fn tell_viewers(&self) {
        let message = ToViewer::Text(self.status_message());
        for viewer in self.viewers.values() {
            let _ = viewer.send(message.clone());
        }
    }

    /// Let go of the input the owner holds, telling the game so. A release packet is sent because
    /// the game is holding keys down on the owner's behalf and would otherwise keep holding them.
    fn release_input(&mut self) {
        if let Some(input) = &self.input {
            if let Ok(packet) = red_core::surface::input_packet(6, &[]) {
                let _ = input.send(packet.to_vec());
            }
        }
        self.owner = None;
    }
}

/// Every reserved surface, and the port they are reached on.
#[derive(Clone)]
pub struct Surfaces {
    items: Arc<Mutex<HashMap<String, Item>>>,
    port: u16,
}

impl Surfaces {
    /// Open the loopback listener and start accepting producers. The port is ephemeral and is
    /// handed to each game in its own environment, so nothing has to agree on a number in advance.
    pub async fn listen() -> std::io::Result<Surfaces> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let surfaces = Surfaces { items: Arc::new(Mutex::new(HashMap::new())), port };
        let accepting = surfaces.clone();
        tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let surfaces = accepting.clone();
                tokio::spawn(async move { surfaces.accept(socket).await });
            }
        });
        Ok(surfaces)
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Mint a token and the environment a game is launched with. The reservation exists before the
    /// game does, which is what makes an unknown token a stranger rather than a race.
    pub fn reserve(&self) -> (String, Vec<(String, String)>) {
        let token = red_core::service::secret();
        let mut items = self.items.lock().expect("surfaces");
        items.insert(token.clone(), Item { token: token.clone(), ..Item::default() });
        (
            token.clone(),
            vec![
                ("RENGINE_SURFACE_PORT".to_string(), self.port.to_string()),
                ("RENGINE_SURFACE_TOKEN".to_string(), token),
            ],
        )
    }

    /// One producer, from its greeting to its close.
    async fn accept(&self, mut socket: TcpStream) {
        let _ = socket.set_nodelay(true);
        let Some((channel, token)) = read_greeting(&mut socket).await else { return };
        /* A token nobody reserved, or a channel already held: both are strangers and both are
           dropped without a word, because a producer that has got this wrong cannot be told
           anything useful over a channel it does not hold. */
        {
            let mut items = self.items.lock().expect("surfaces");
            let Some(item) = items.get_mut(&token) else { return };
            let taken = match channel {
                Channel::Frames => item.frames_connected,
                Channel::Input => item.input.is_some(),
            };
            if taken {
                return;
            }
        }
        match channel {
            Channel::Frames => self.serve_frames(socket, &token).await,
            Channel::Input => self.serve_input(socket, &token).await,
        }
    }

    async fn serve_frames(&self, mut socket: TcpStream, token: &str) {
        {
            let mut items = self.items.lock().expect("surfaces");
            let Some(item) = items.get_mut(token) else { return };
            item.frames_connected = true;
            item.tell_viewers();
        }
        let mut decoder = Decoder::new();
        let mut buffer = vec![0u8; 1 << 16];
        loop {
            let read = match socket.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(count) => count,
            };
            match decoder.push(&buffer[..read]) {
                /* A stream that has sent one bad header has lost its place in it: there is no
                   resynchronising, so the producer is dropped exactly as the JavaScript drops it. */
                Err(_) => break,
                Ok(frames) => {
                    let mut items = self.items.lock().expect("surfaces");
                    let Some(item) = items.get_mut(token) else { break };
                    for frame in frames {
                        item.frame_count += 1;
                        item.width = frame.width;
                        item.height = frame.height;
                        let mut bytes = frame_header(frame.width, frame.height, frame.sequence).to_vec();
                        bytes.extend_from_slice(&frame.pixels);
                        for viewer in item.viewers.values() {
                            let _ = viewer.send(ToViewer::Binary(bytes.clone()));
                        }
                        item.latest = Some(bytes);
                    }
                }
            }
        }
        let mut items = self.items.lock().expect("surfaces");
        if let Some(item) = items.get_mut(token) {
            item.frames_connected = false;
            item.tell_viewers();
        }
    }

    async fn serve_input(&self, socket: TcpStream, token: &str) {
        let (mut reading, mut writing) = socket.into_split();
        let (sender, mut outgoing) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        {
            let mut items = self.items.lock().expect("surfaces");
            let Some(item) = items.get_mut(token) else { return };
            item.input = Some(sender);
            item.tell_viewers();
        }
        /* The input channel is one-way. A producer that writes to it has misunderstood the
           protocol, and the JavaScript destroys the socket for it; reading is how this notices. */
        let mut scratch = [0u8; 1];
        loop {
            tokio::select! {
                packet = outgoing.recv() => {
                    let Some(packet) = packet else { break };
                    if writing.write_all(&packet).await.is_err() { break }
                }
                read = reading.read(&mut scratch) => match read {
                    Ok(0) | Err(_) => break,
                    Ok(_) => break,
                },
            }
        }
        let mut items = self.items.lock().expect("surfaces");
        if let Some(item) = items.get_mut(token) {
            item.input = None;
            item.owner = None;
            item.tell_viewers();
        }
    }

    /// A viewer joins: it is told the status at once, and handed the latest frame if there is one.
    pub fn attach(&self, token: &str, viewer: ViewerId, to_viewer: UnboundedSender<ToViewer>) -> bool {
        let mut items = self.items.lock().expect("surfaces");
        let Some(item) = items.get_mut(token) else { return false };
        let _ = to_viewer.send(ToViewer::Text(item.status_message()));
        if let Some(latest) = &item.latest {
            let _ = to_viewer.send(ToViewer::Binary(latest.clone()));
        }
        item.viewers.insert(viewer, to_viewer);
        true
    }

    /// One input message from one viewer. `Ok(())` when it was delivered or deliberately dropped;
    /// `Err` carries the sentence the viewer is told, which is the JavaScript's.
    ///
    /// **This is the focus-eviction semantic, verbatim** (F189 criterion 2, `surfaces.mjs:72-76`).
    pub fn from_viewer(&self, token: &str, viewer: ViewerId, kind: i32, values: &[i32]) -> Result<(), String> {
        let packet = red_core::surface::input_packet(kind, values)?;
        let mut items = self.items.lock().expect("surfaces");
        let Some(item) = items.get_mut(token) else { return Err("Game input is disconnected.".to_string()) };
        /* A focus GAIN takes ownership, releasing whoever held it first — that release goes to the
           game, so the previous owner's held keys are let go rather than left down. */
        if kind == 5 && values.first() == Some(&1) {
            if item.owner != Some(viewer) {
                item.release_input();
            }
            item.owner = Some(viewer);
        }
        /* And a viewer that is not the owner is dropped SILENTLY. Not refused: a viewer that is not
           focused learns nothing about the one that is. */
        if item.owner != Some(viewer) {
            return Ok(());
        }
        let Some(input) = item.input.clone() else { return Err("Game input is disconnected.".to_string()) };
        if input.send(packet.to_vec()).is_err() {
            return Err("Game input is disconnected.".to_string());
        }
        /* A focus LOSS or an explicit release gives the input up, so the next viewer to take focus
           does not have to wait for this one to close. */
        if kind == 6 || (kind == 5 && values.first() != Some(&1)) {
            item.release_input();
        }
        Ok(())
    }

    /// A viewer leaves. If it held the input, the game is told so rather than left holding keys.
    pub fn detach(&self, token: &str, viewer: ViewerId) {
        let mut items = self.items.lock().expect("surfaces");
        let Some(item) = items.get_mut(token) else { return };
        item.viewers.remove(&viewer);
        if item.owner == Some(viewer) {
            item.release_input();
        }
    }

    /// The game has exited: the reservation goes, and every viewer is closed rather than left
    /// watching a picture that will never change.
    pub fn remove(&self, token: &str) -> Vec<UnboundedSender<ToViewer>> {
        let mut items = self.items.lock().expect("surfaces");
        let Some(mut item) = items.remove(token) else { return Vec::new() };
        item.release_input();
        item.viewers.into_values().collect()
    }

    /// The surface a pane holds, for the route that attaches a viewer to a session.
    pub fn token_of(&self, session: &str) -> Option<String> {
        let items = self.items.lock().expect("surfaces");
        items.values().find(|item| item.session.as_deref() == Some(session)).map(|item| item.token.clone())
    }

    /// Bind a reservation to the pane that was launched on it.
    pub fn claim(&self, token: &str, session: &str) {
        let mut items = self.items.lock().expect("surfaces");
        if let Some(item) = items.get_mut(token) {
            item.session = Some(session.to_string());
        }
    }

    #[cfg(test)]
    fn with<T>(&self, token: &str, read: impl FnOnce(&mut Item) -> T) -> Option<T> {
        let mut items = self.items.lock().expect("surfaces");
        items.get_mut(token).map(read)
    }
}

/// The greeting line, bounded. Returns `None` for anything that is not one — including a line that
/// passes the limit without ending, which is how a producer would otherwise grow this buffer.
async fn read_greeting(socket: &mut TcpStream) -> Option<(Channel, String)> {
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    let deadline = tokio::time::Duration::from_secs(3);
    loop {
        match tokio::time::timeout(deadline, socket.read(&mut byte)).await {
            Ok(Ok(1)) => {}
            _ => return None,
        }
        if byte[0] == b'\n' {
            break;
        }
        line.push(byte[0]);
        if line.len() > GREETING_LIMIT {
            return None;
        }
    }
    greeting(std::str::from_utf8(&line).ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc::unbounded_channel;

    fn surfaces() -> Surfaces {
        Surfaces { items: Arc::new(Mutex::new(HashMap::new())), port: 0 }
    }

    /// A reserved surface with an input channel whose packets this test can read.
    fn reserved(surfaces: &Surfaces) -> (String, tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>) {
        let (token, _) = surfaces.reserve();
        let (sender, receiver) = unbounded_channel();
        surfaces.with(&token, |item| {
            item.input = Some(sender);
            item.frames_connected = true;
        });
        (token, receiver)
    }

    /// The kinds the game was actually sent, in order, so a test can state a sequence rather than
    /// count receives.
    fn delivered(input: &mut tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>) -> Vec<i32> {
        let mut kinds = Vec::new();
        while let Ok(packet) = input.try_recv() {
            kinds.push(i32::from_le_bytes(packet[0..4].try_into().expect("four bytes")));
        }
        kinds
    }

    /* F189 criterion 2, the whole of it. The eviction is what lets a person click into a game
       another viewer holds; the silence is what stops a viewer that is not focused from learning
       anything about the one that is.

       Note the release that precedes EVERY focus gain, including the first. `item.owner` starts
       unset and the JavaScript compares it to the viewer — `undefined !== viewer` — so a release
       goes to the game before the first focus packet too. It reads like an oversight and it is not
       one to change here: a port preserves what it replaces, and a game that receives a release it
       was not holding anything for ignores it. */
    #[test]
    fn focus_evicts_the_previous_owner_and_a_non_owner_is_dropped_silently() {
        let surfaces = surfaces();
        let (token, mut input) = reserved(&surfaces);
        let (one, two) = (1u64, 2u64);

        /* Before anyone has focus, nobody owns it: a key from either is dropped, not delivered. */
        assert_eq!(surfaces.from_viewer(&token, one, 1, &[26, 1, 0]), Ok(()));
        assert_eq!(delivered(&mut input), Vec::<i32>::new(), "a viewer with no focus delivers nothing");

        /* One takes focus — a release, then the focus packet — and its keys then arrive. */
        assert_eq!(surfaces.from_viewer(&token, one, 5, &[1]), Ok(()));
        assert_eq!(delivered(&mut input), vec![6, 5], "the release precedes the focus, from the first one");
        assert_eq!(surfaces.from_viewer(&token, one, 1, &[26, 1, 0]), Ok(()));
        assert_eq!(delivered(&mut input), vec![1], "the owner's key arrives");

        /* Two takes focus. One is EVICTED, and the game is told to let go of what one was holding
           BEFORE two's focus packet arrives — that ordering is the semantic. */
        assert_eq!(surfaces.from_viewer(&token, two, 5, &[1]), Ok(()));
        assert_eq!(delivered(&mut input), vec![6, 5], "the previous owner is released, then two takes it");

        /* And one, no longer the owner, is dropped SILENTLY — Ok, with nothing delivered. */
        assert_eq!(surfaces.from_viewer(&token, one, 1, &[26, 1, 0]), Ok(()), "a non-owner is not refused");
        assert_eq!(delivered(&mut input), Vec::<i32>::new(), "and nothing of its reaches the game");
    }

    #[test]
    fn losing_focus_gives_the_input_up_rather_than_holding_it() {
        let surfaces = surfaces();
        let (token, mut input) = reserved(&surfaces);
        surfaces.from_viewer(&token, 1, 5, &[1]).expect("focus");
        delivered(&mut input);
        surfaces.from_viewer(&token, 1, 5, &[0]).expect("focus lost");
        assert_eq!(delivered(&mut input), vec![5, 6], "the focus-lost packet, then the release it causes");
        assert_eq!(surfaces.with(&token, |item| item.owner), Some(None), "nobody owns it now");
    }

    #[test]
    fn a_viewer_that_leaves_holding_the_input_lets_go_of_it() {
        let surfaces = surfaces();
        let (token, mut input) = reserved(&surfaces);
        let (sender, _viewer) = unbounded_channel();
        surfaces.attach(&token, 1, sender);
        surfaces.from_viewer(&token, 1, 5, &[1]).expect("focus");
        delivered(&mut input);
        surfaces.detach(&token, 1);
        assert_eq!(delivered(&mut input), vec![6], "leaving releases what it held");
    }

    #[test]
    fn a_viewer_is_told_the_status_and_handed_the_frame_already_drawn() {
        let surfaces = surfaces();
        let (token, _input) = reserved(&surfaces);
        surfaces.with(&token, |item| {
            item.frame_count = 3;
            item.latest = Some(vec![1, 2, 3, 4]);
        });
        let (sender, mut viewer) = unbounded_channel();
        assert!(surfaces.attach(&token, 1, sender));
        match viewer.try_recv().expect("a status first") {
            ToViewer::Text(text) => {
                assert!(text.contains(r#""status":"Live""#), "{text}");
                assert!(text.contains(r#""frameCount":3"#), "{text}");
            }
            other => panic!("expected a status, got {other:?}"),
        }
        assert_eq!(viewer.try_recv().expect("then the latest frame"), ToViewer::Binary(vec![1, 2, 3, 4]));
    }

    /* The three words a surface can be in, and which producer being absent gives which. */
    #[test]
    fn the_status_says_which_half_is_missing() {
        let surfaces = surfaces();
        let (token, _) = surfaces.reserve();
        assert_eq!(surfaces.with(&token, |item| item.status()), Some("Video disconnected"));
        surfaces.with(&token, |item| item.frames_connected = true);
        assert_eq!(surfaces.with(&token, |item| item.status()), Some("Input disconnected"));
        let (sender, _keep) = unbounded_channel();
        surfaces.with(&token, |item| item.input = Some(sender));
        assert_eq!(surfaces.with(&token, |item| item.status()), Some("Live"));
        /* And a surface with input but no video is still Video disconnected: a picture is what a
           viewer came for, so that is the word it gets. */
        surfaces.with(&token, |item| item.frames_connected = false);
        assert_eq!(surfaces.with(&token, |item| item.status()), Some("Video disconnected"));
    }

    #[test]
    fn an_unreserved_surface_takes_no_viewer_and_no_input() {
        let surfaces = surfaces();
        let (sender, _viewer) = unbounded_channel();
        assert!(!surfaces.attach("nobody", 1, sender), "a token nobody reserved");
        assert!(surfaces.from_viewer("nobody", 1, 5, &[1]).is_err());
    }

    /* An input the format refuses never reaches the game, and the viewer is told why — the one case
       where a viewer IS answered rather than ignored. */
    #[test]
    fn an_input_the_format_refuses_is_answered_not_delivered() {
        let surfaces = surfaces();
        let (token, mut input) = reserved(&surfaces);
        surfaces.from_viewer(&token, 1, 5, &[1]).expect("focus");
        delivered(&mut input);
        assert_eq!(surfaces.from_viewer(&token, 1, 99, &[]), Err("Unsupported game input.".to_string()));
        assert_eq!(delivered(&mut input), Vec::<i32>::new(), "nothing reached the game");
    }
}
