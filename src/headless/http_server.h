#pragma once

/**
 * A minimal HTTP/1.1 server for the headless engine server: one
 * request per connection (Connection: close), every response open to
 * any origin, and a handler that answers each request. Nothing here
 * knows the engine.
 */

#include <juce_core/juce_core.h>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace celestrian::http {

struct Request {
  juce::String method;
  juce::String path;  // without its query string
  std::map<juce::String, juce::String> headers;  // names in lower case
  juce::String body;
};

struct Response {
  int status = 200;
  juce::String mime = "text/plain";
  juce::MemoryBlock body;
};

/** An empty response with `status`. */
inline Response statusOnly(int status) { return {status, "text/plain", {}}; }

/** 200 with `value` as JSON. */
inline Response json(const juce::var& value) {
  const auto text = juce::JSON::toString(value, true).toStdString();
  return {200, "application/json", juce::MemoryBlock(text.data(), text.size())};
}

inline constexpr int kSocketTimeoutMs = 5000;

/** Reads one request: the head, then `Content-Length` bytes of body.
 * False when the peer sends nothing in time (a browser's speculative
 * connection) or the head is not a request line. */
inline bool readRequest(juce::StreamingSocket& socket, Request& request) {
  static constexpr const char* kHeadEnd = "\r\n\r\n";
  static constexpr size_t kHeadEndLength = 4;
  std::vector<char> data;
  size_t head_end = std::string::npos;
  int64_t content_length = 0;
  char chunk[8192];
  while (head_end == std::string::npos ||
         (int64_t)(data.size() - head_end - kHeadEndLength) < content_length) {
    if (socket.waitUntilReady(true, kSocketTimeoutMs) <= 0) return false;
    const int count = socket.read(chunk, (int)sizeof(chunk), false);
    if (count <= 0) return false;
    data.insert(data.end(), chunk, chunk + count);
    if (head_end != std::string::npos) continue;
    const std::string text(data.data(), data.size());
    head_end = text.find(kHeadEnd);
    if (head_end == std::string::npos) continue;
    juce::StringArray lines;
    lines.addLines(juce::String(text.substr(0, head_end)));
    if (lines.isEmpty()) return false;
    juce::StringArray request_line;
    request_line.addTokens(lines[0], " ", "");
    if (request_line.size() < 2) return false;
    request.method = request_line[0];
    request.path = request_line[1].upToFirstOccurrenceOf("?", false, false);
    for (int i = 1; i < lines.size(); ++i) {
      request.headers[lines[i]
                          .upToFirstOccurrenceOf(":", false, false)
                          .trim()
                          .toLowerCase()] =
          lines[i].fromFirstOccurrenceOf(":", false, false).trim();
    }
    const auto length = request.headers.find("content-length");
    content_length = length != request.headers.end()
                         ? length->second.getLargeIntValue()
                         : 0;
  }
  request.body = juce::String::fromUTF8(
      data.data() + head_end + kHeadEndLength, (int)content_length);
  return true;
}

/** Writes every byte. One send takes only part of a large body, and a
 * body cut short reads as "Failed to fetch" in the browser. */
inline bool writeAll(juce::StreamingSocket& socket, const void* data,
                     size_t size) {
  static constexpr size_t kMaxSend = 1 << 16;
  const char* bytes = static_cast<const char*>(data);
  size_t sent = 0;
  while (sent < size) {
    if (socket.waitUntilReady(false, kSocketTimeoutMs) <= 0) return false;
    const int count =
        socket.write(bytes + sent, (int)std::min(size - sent, kMaxSend));
    if (count < 0) return false;
    sent += (size_t)count;
  }
  return true;
}

inline void respond(juce::StreamingSocket& socket, const Response& response) {
  const char* reason = response.status == 200   ? "OK"
                       : response.status == 204 ? "No Content"
                       : response.status == 404 ? "Not Found"
                                                : "Bad Request";
  juce::String head;
  head << "HTTP/1.1 " << response.status << " " << reason << "\r\n"
       << "Content-Type: " << response.mime << "\r\n"
       << "Content-Length: " << (int64_t)response.body.getSize() << "\r\n"
       << "Cache-Control: no-store\r\n"
       << "Access-Control-Allow-Origin: *\r\n"
       << "Access-Control-Allow-Headers: Content-Type\r\n"
       << "Connection: close\r\n\r\n";
  const auto head_bytes = head.toStdString();
  if (!writeAll(socket, head_bytes.data(), head_bytes.size())) return;
  if (response.body.getSize() > 0)
    writeAll(socket, response.body.getData(), response.body.getSize());
}

/** Accepts on 127.0.0.1:`port` and answers each request with
 * `handler(request)`; a CORS preflight (OPTIONS) is answered here.
 * ONE THREAD PER CONNECTION: a slow request (a long render) and a
 * connection the browser opens and never writes to must not stall the
 * others — so `handler` is called from many threads at once. */
class Server : public juce::Thread {
 public:
  using Handler = std::function<Response(const Request&)>;

  Server(int port, Handler handler)
      : juce::Thread("engine http"), port_(port), handler_(std::move(handler)) {}

  /** False when the port cannot be bound. */
  bool listen() { return listener_.createListener(port_, "127.0.0.1"); }

  void stopListening() { listener_.close(); }

  void run() override {
    while (!threadShouldExit()) {
      std::shared_ptr<juce::StreamingSocket> connection(
          listener_.waitForNextConnection());
      if (connection == nullptr) continue;
      juce::Thread::launch([this, connection] {
        Request request;
        if (readRequest(*connection, request)) {
          respond(*connection, request.method == "OPTIONS"
                                   ? statusOnly(204)
                                   : handler_(request));
        }
        connection->close();
      });
    }
  }

 private:
  const int port_;
  const Handler handler_;
  juce::StreamingSocket listener_;
};

}  // namespace celestrian::http
