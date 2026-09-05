#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <sys/socket.h>
#include <unistd.h>
#endif
#include "surface.h"
#include <SDL_opengl.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {
#ifdef _WIN32
using Socket = SOCKET;
constexpr Socket invalidSocket = INVALID_SOCKET;
void closeSocket(Socket fd) { closesocket(fd); }
void interruptSocket(Socket fd) { if (fd != invalidSocket) shutdown(fd, SD_BOTH); }
#else
using Socket = int;
constexpr Socket invalidSocket = -1;
void closeSocket(Socket fd) { close(fd); }
void interruptSocket(Socket fd) { if (fd != invalidSocket) shutdown(fd, SHUT_RDWR); }
#endif
using Clock = std::chrono::steady_clock;
using Input = std::array<int32_t, 8>;

void put32(uint8_t* bytes, uint32_t value) {
    for (int i = 0; i < 4; ++i) bytes[i] = static_cast<uint8_t>(value >> (i * 8));
}
uint32_t get32(const uint8_t* bytes) {
    return uint32_t(bytes[0]) | uint32_t(bytes[1]) << 8 | uint32_t(bytes[2]) << 16 | uint32_t(bytes[3]) << 24;
}
bool sendAll(Socket fd, const uint8_t* bytes, size_t count) {
    while (count) {
#ifdef MSG_NOSIGNAL
        constexpr int flags = MSG_NOSIGNAL;
#else
        constexpr int flags = 0;
#endif
        const auto sent = send(fd, reinterpret_cast<const char*>(bytes), static_cast<int>(count), flags);
        if (sent <= 0) return false;
        bytes += sent; count -= static_cast<size_t>(sent);
    }
    return true;
}

class Surface {
public:
    bool enabled = false;
    SDL_Window* window = nullptr;
    std::array<bool, SDL_NUM_SCANCODES> keys{};
    uint32_t buttons = 0;
    std::deque<SDL_Event> events;

    Surface() {
        const char* token = std::getenv("RENGINE_SURFACE_TOKEN");
        const char* port = std::getenv("RENGINE_SURFACE_PORT");
        if (!token || !port || std::strlen(token) != 64) return;
        for (size_t i = 0; i < 64; ++i) if (!((token[i] >= '0' && token[i] <= '9') || (token[i] >= 'a' && token[i] <= 'f'))) return;
        char* end = nullptr;
        const long parsed = std::strtol(port, &end, 10);
        if (!end || *end || parsed < 1 || parsed > 65535) return;
        portNumber = static_cast<uint16_t>(parsed); capability = token;
#ifdef _WIN32
        WSADATA data{};
        if (WSAStartup(MAKEWORD(2, 2), &data) != 0) return;
#endif
        enabled = true;
        writer = std::thread([this] { writeLoop(); });
        reader = std::thread([this] { readLoop(); });
        std::fprintf(stderr, "rEngine SDL surface v1 enabled\n");
    }
    ~Surface() {
        running = false; available.notify_all();
        interruptSocket(frameSocket.load()); interruptSocket(inputSocket.load());
        if (writer.joinable()) writer.join();
        if (reader.joinable()) reader.join();
#ifdef _WIN32
        if (enabled) WSACleanup();
#endif
    }
    void frame(SDL_Window* target) {
        window = target;
        if (!enabled || !connected) return;
        const auto now = Clock::now();
        if (now - lastFrame < std::chrono::microseconds(33333)) return;
        lastFrame = now;
        int width = 0, height = 0;
        SDL_GL_GetDrawableSize(target, &width, &height);
        if (width < 1 || height < 1 || width > 1920 || height > 1080) return;
        using BindFramebuffer = void (APIENTRY*)(GLenum, GLuint);
        using BindBuffer = void (APIENTRY*)(GLenum, GLuint);
        const auto bindFramebuffer = reinterpret_cast<BindFramebuffer>(SDL_GL_GetProcAddress("glBindFramebuffer"));
        const auto bindBuffer = reinterpret_cast<BindBuffer>(SDL_GL_GetProcAddress("glBindBuffer"));
        if (!bindFramebuffer || !bindBuffer) return;
        std::vector<uint8_t> packet(24 + static_cast<size_t>(width) * height * 4);
        const uint32_t header[] = {0x31464752, static_cast<uint32_t>(width), static_cast<uint32_t>(height), ++sequence,
            static_cast<uint32_t>(packet.size() - 24), 0};
        for (int i = 0; i < 6; ++i) put32(packet.data() + i * 4, header[i]);
        GLint readFbo = 0, packBuffer = 0, readBuffer = 0, alignment = 0, rowLength = 0, skipRows = 0, skipPixels = 0;
        glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &readFbo);
        glGetIntegerv(GL_PIXEL_PACK_BUFFER_BINDING, &packBuffer);
        glGetIntegerv(GL_PACK_ALIGNMENT, &alignment); glGetIntegerv(GL_PACK_ROW_LENGTH, &rowLength);
        glGetIntegerv(GL_PACK_SKIP_ROWS, &skipRows); glGetIntegerv(GL_PACK_SKIP_PIXELS, &skipPixels);
        bindFramebuffer(GL_READ_FRAMEBUFFER, 0); glGetIntegerv(GL_READ_BUFFER, &readBuffer);
        bindBuffer(GL_PIXEL_PACK_BUFFER, 0); glPixelStorei(GL_PACK_ALIGNMENT, 1); glPixelStorei(GL_PACK_ROW_LENGTH, 0);
        glPixelStorei(GL_PACK_SKIP_ROWS, 0); glPixelStorei(GL_PACK_SKIP_PIXELS, 0); glReadBuffer(GL_BACK);
        glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, packet.data() + 24);
        glReadBuffer(readBuffer); bindFramebuffer(GL_READ_FRAMEBUFFER, readFbo); bindBuffer(GL_PIXEL_PACK_BUFFER, packBuffer);
        glPixelStorei(GL_PACK_ALIGNMENT, alignment); glPixelStorei(GL_PACK_ROW_LENGTH, rowLength);
        glPixelStorei(GL_PACK_SKIP_ROWS, skipRows); glPixelStorei(GL_PACK_SKIP_PIXELS, skipPixels);
        { std::lock_guard<std::mutex> lock(frameMutex); pending.swap(packet); }
        available.notify_one();
    }
    bool next(SDL_Event* event) {
        if (!enabled || !event) return false;
        if (events.empty()) {
            std::deque<Input> incoming;
            { std::lock_guard<std::mutex> lock(inputMutex); incoming.swap(inputs); }
            for (const auto& input : incoming) translate(input);
        }
        if (events.empty()) return false;
        *event = events.front(); events.pop_front(); return true;
    }
private:
    std::atomic<bool> running{true}, connected{false};
    std::atomic<Socket> frameSocket{invalidSocket}, inputSocket{invalidSocket};
    uint16_t portNumber = 0;
    uint32_t sequence = 0;
    std::string capability;
    std::thread writer, reader;
    std::mutex frameMutex, inputMutex;
    std::condition_variable available;
    std::vector<uint8_t> pending;
    std::deque<Input> inputs;
    Clock::time_point lastFrame{};

    Socket connectChannel(const char* channel) {
        Socket fd = socket(AF_INET, SOCK_STREAM, 0);
        if (fd == invalidSocket) return fd;
#ifdef _WIN32
        const DWORD timeout = 300;
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
#else
        const timeval timeout{0, 300000};
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
#ifdef SO_NOSIGPIPE
        const int noSignal = 1;
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, sizeof(noSignal));
#endif
#endif
        sockaddr_in address{}; address.sin_family = AF_INET; address.sin_port = htons(portNumber);
        address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        if (connect(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0) { closeSocket(fd); return invalidSocket; }
        const std::string greeting = std::string("RENGINE/1 ") + channel + " " + capability + "\n";
        if (!sendAll(fd, reinterpret_cast<const uint8_t*>(greeting.data()), greeting.size())) { closeSocket(fd); return invalidSocket; }
        return fd;
    }
    void retry() { std::this_thread::sleep_for(std::chrono::milliseconds(200)); }
    void writeLoop() {
        while (running) {
            const Socket fd = connectChannel("FRAME");
            if (fd == invalidSocket) { retry(); continue; }
            frameSocket = fd; connected = true;
            while (running) {
                std::vector<uint8_t> packet;
                {
                    std::unique_lock<std::mutex> lock(frameMutex);
                    available.wait_for(lock, std::chrono::milliseconds(200), [this] { return !pending.empty() || !running; });
                    packet.swap(pending);
                }
                if (!packet.empty() && !sendAll(fd, packet.data(), packet.size())) break;
            }
            connected = false; frameSocket = invalidSocket; closeSocket(fd);
        }
    }
    void enqueue(const Input& input) {
        std::lock_guard<std::mutex> lock(inputMutex);
        if (inputs.size() >= 256) { inputs.clear(); inputs.push_back(Input{6}); }
        inputs.push_back(input);
    }
    void readLoop() {
        while (running) {
            const Socket fd = connectChannel("INPUT");
            if (fd == invalidSocket) { retry(); continue; }
            inputSocket = fd;
            std::array<uint8_t, 32> bytes{}; size_t offset = 0;
            while (running) {
                const auto count = recv(fd, reinterpret_cast<char*>(bytes.data() + offset), static_cast<int>(bytes.size() - offset), 0);
                if (count <= 0) break;
                offset += static_cast<size_t>(count);
                if (offset == bytes.size()) {
                    Input input{};
                    for (int i = 0; i < 8; ++i) input[i] = static_cast<int32_t>(get32(bytes.data() + i * 4));
                    enqueue(input); offset = 0;
                }
            }
            inputSocket = invalidSocket; closeSocket(fd); enqueue(Input{6}); retry();
        }
    }
    Uint32 windowId() const { return window ? SDL_GetWindowID(window) : 0; }
    void key(int scancode, bool down, bool repeat) {
        if (scancode < 0 || scancode >= SDL_NUM_SCANCODES) return;
        keys[scancode] = down;
        SDL_Event event{}; event.type = down ? SDL_KEYDOWN : SDL_KEYUP;
        event.key.windowID = windowId(); event.key.state = down ? SDL_PRESSED : SDL_RELEASED;
        event.key.repeat = repeat; event.key.keysym.scancode = static_cast<SDL_Scancode>(scancode);
        event.key.keysym.sym = SDL_GetKeyFromScancode(event.key.keysym.scancode);
        event.key.keysym.mod = (keys[SDL_SCANCODE_LSHIFT] || keys[SDL_SCANCODE_RSHIFT] ? KMOD_SHIFT : 0)
            | (keys[SDL_SCANCODE_LCTRL] || keys[SDL_SCANCODE_RCTRL] ? KMOD_CTRL : 0)
            | (keys[SDL_SCANCODE_LALT] || keys[SDL_SCANCODE_RALT] ? KMOD_ALT : 0);
        events.push_back(event);
    }
    void button(int value, bool down, int x, int y) {
        if (value < 1 || value > 5) return;
        if (down) buttons |= SDL_BUTTON(value); else buttons &= ~SDL_BUTTON(value);
        SDL_Event event{}; event.type = down ? SDL_MOUSEBUTTONDOWN : SDL_MOUSEBUTTONUP;
        event.button.windowID = windowId(); event.button.button = static_cast<Uint8>(value);
        event.button.state = down ? SDL_PRESSED : SDL_RELEASED; event.button.clicks = 1;
        event.button.x = x; event.button.y = y; events.push_back(event);
    }
    void translate(const Input& input) {
        SDL_Event event{};
        switch (input[0]) {
        case 1: key(input[1], input[2] != 0, input[3] != 0); break;
        case 2:
            event.type = SDL_MOUSEMOTION; event.motion.windowID = windowId(); event.motion.state = buttons;
            event.motion.x = input[1]; event.motion.y = input[2]; event.motion.xrel = input[3]; event.motion.yrel = input[4];
            events.push_back(event); break;
        case 3: button(input[1], input[2] != 0, input[3], input[4]); break;
        case 4:
            event.type = SDL_MOUSEWHEEL; event.wheel.windowID = windowId(); event.wheel.x = input[1]; event.wheel.y = input[2];
            events.push_back(event); break;
        case 5:
            event.type = SDL_WINDOWEVENT; event.window.windowID = windowId();
            event.window.event = input[1] ? SDL_WINDOWEVENT_FOCUS_GAINED : SDL_WINDOWEVENT_FOCUS_LOST;
            events.push_back(event); break;
        case 6:
            for (int i = 0; i < SDL_NUM_SCANCODES; ++i) if (keys[i]) key(i, false, false);
            for (int i = 1; i <= 5; ++i) if (buttons & SDL_BUTTON(i)) button(i, false, 0, 0);
            break;
        default: break;
        }
    }
};
Surface& surface() { static Surface instance; return instance; }
}

extern "C" void rengine_surface_before_swap(SDL_Window* window) { surface().frame(window); }
extern "C" int rengine_surface_next_event(SDL_Event* event) { return surface().next(event) ? 1 : 0; }
extern "C" bool rengine_surface_enabled() { return surface().enabled; }
