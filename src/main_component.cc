#include "main_component.h"

// Pristine UI with confirmed bridge and no gibberish icons
static const char *embedded_ui_html = R"html(
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Celestrian DAW</title>
    <style>
        :root {
            --bg-color: #0f172a; --panel-color: #1e293b; --accent-color: #38bdf8;
            --text-color: #f8fafc; --record-color: #ef4444; --play-color: #22c55e;
        }
        body {
            margin: 0; padding: 24px; background-color: var(--bg-color); color: var(--text-color);
            font-family: system-ui, -apple-system, sans-serif;
            height: 100vh; display: flex; flex-direction: column; box-sizing: border-box; overflow: hidden;
        }
        header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
        h1 { margin: 0; font-size: 28px; color: var(--accent-color); font-weight: 800; }
        .status-badge { background: #1e293b; padding: 6px 14px; border-radius: 99px; font-size: 11px; font-weight: 700; border: 1px solid #334155; }
        .status-badge.connected { color: #10b981; border-color: #064e3b; }
        .controls { display: flex; gap: 16px; background: var(--panel-color); padding: 20px; border-radius: 16px; margin-bottom: 24px; align-items: center; }
        button {
            padding: 12px 24px; border: none; border-radius: 12px; font-weight: 700; cursor: pointer;
            background: #334155; color: white; transition: all 0.2s;
        }
        button:hover { background: #475569; transform: translateY(-1px); }
        button.btn-record.active { background-color: var(--record-color); }
        .waveform-container { flex-grow: 1; background: #020617; border-radius: 20px; position: relative; border: 1px solid #1e293b; }
        canvas { width: 100%; height: 100%; }
        #debug-log {
            margin-top: 20px; background: #000; color: #10b981; font-family: monospace; font-size: 11px;
            padding: 16px; border-radius: 12px; height: 100px; overflow-y: auto; border: 1px solid #064e3b;
        }
    </style>
</head>
<body>
    <header>
        <h1>Celestrian</h1>
        <div id="bridge-status" class="status-badge">CONNECTING...</div>
    </header>
    <div class="controls">
        <button id="record-btn" class="btn-record" onclick="toggleRecord()">Record</button>
        <button id="play-btn" onclick="togglePlay()">Playback</button>
        <div style="flex-grow: 1;"></div>
        <button onclick="location.reload()" style="opacity: 0.5;">Reload</button>
    </div>
    <div class="waveform-container"><canvas id="waveform"></canvas></div>
    <div id="debug-log">System Boot...</div>

    <script>
        const canvas = document.getElementById('waveform');
        const ctx = canvas.getContext('2d');
        const logArea = document.getElementById('debug-log');
        const statusBadge = document.getElementById('bridge-status');
        
        function log(m) {
            const line = document.createElement('div');
            line.textContent = `[${new Date().toLocaleTimeString()}] ${m}`;
            logArea.appendChild(line);
            logArea.scrollTop = logArea.scrollHeight;
        }

        let resultIdCounter = 0;
        const pendingCalls = new Map();

        async function callNative(name, ...args) {
            const b = window.__JUCE__;
            if (!b || !b.backend) { log("Err: Bridge offline."); return null; }
            return new Promise((resolve) => {
                const resultId = resultIdCounter++;
                pendingCalls.set(resultId, resolve);
                b.backend.emitEvent('__juce__invoke', { name: name, params: args, resultId: resultId });
                setTimeout(() => {
                    if (pendingCalls.has(resultId)) { log(`Timeout: ${name}`); pendingCalls.delete(resultId); resolve(null); }
                }, 5000);
            });
        }

        function initBridge() {
            const b = window.__JUCE__;
            if (b && b.backend && !window.bridgeInited) {
                log("Bridge Ready.");
                b.backend.addEventListener('__juce__complete', (res) => {
                    if (pendingCalls.has(res.promiseId)) {
                        pendingCalls.get(res.promiseId)(res.result);
                        pendingCalls.delete(res.promiseId);
                    }
                });
                window.bridgeInited = true;
                statusBadge.innerText = "CONNECTED";
                statusBadge.classList.add('connected');
            }
        }
        setInterval(initBridge, 500);

        let recording = false;
        async function toggleRecord() {
            recording = !recording;
            const btn = document.getElementById('record-btn');
            btn.classList.toggle('active', recording);
            btn.innerText = recording ? "Stop" : "Record";
            log(recording ? "Rec Start" : "Rec Stop");
            await callNative(recording ? 'startRecording' : 'stopRecording');
            if (!recording) updateWaveform();
        }

        async function togglePlay() { log("Play Triggered"); await callNative('startPlayback'); }

        async function updateWaveform() {
            log("Fetching Waveform...");
            const peaks = await callNative('getWaveform', 800);
            if (!peaks || peaks.length === 0) return;
            const dpr = window.devicePixelRatio || 1;
            canvas.width = canvas.clientWidth * dpr;
            canvas.height = canvas.clientHeight * dpr;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const centerY = canvas.height / 2;
            const barWidth = canvas.width / peaks.length;
            ctx.fillStyle = '#38bdf8';
            peaks.forEach((p, i) => {
                const h = Math.max(2 * dpr, p * canvas.height * 0.9);
                ctx.fillRect(i * barWidth, centerY - h/2, barWidth - 1, h);
            });
        }

        window.onload = () => {
            canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight;
            log("UI Loaded.");
        };
    </script>
</body>
</html>
)html";

MainComponent::MainComponent()
    : web_browser(
          juce::WebBrowserComponent::Options{}
              .withNativeIntegrationEnabled()
              .withNativeFunction(
                  "ping",
                  [](const juce::Array<juce::var> &args,
                     juce::WebBrowserComponent::NativeFunctionCompletion
                         completion) {
                    juce::Logger::writeToLog("Bridge: ping received!");
                    completion("pong");
                  })
              .withNativeFunction(
                  "startRecording",
                  [this](const juce::Array<juce::var> &args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    juce::Logger::writeToLog("Bridge: startRecording called");
                    audio_engine.startRecording();
                    completion(true);
                  })
              .withNativeFunction(
                  "stopRecording",
                  [this](const juce::Array<juce::var> &args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    juce::Logger::writeToLog("Bridge: stopRecording called");
                    audio_engine.stopRecording();
                    completion(true);
                  })
              .withNativeFunction(
                  "startPlayback",
                  [this](const juce::Array<juce::var> &args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    juce::Logger::writeToLog("Bridge: startPlayback called");
                    audio_engine.startPlayback();
                    completion(true);
                  })
              .withNativeFunction(
                  "getWaveform",
                  [this](const juce::Array<juce::var> &args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    juce::Logger::writeToLog("Bridge: getWaveform called");
                    int num_peaks_val = args.size() > 0 ? (int)args[0] : 100;
                    completion(audio_engine.getWaveformAsJSON(num_peaks_val));
                  })
              .withNativeFunction(
                  "consoleLog",
                  [](const juce::Array<juce::var> &args,
                     juce::WebBrowserComponent::NativeFunctionCompletion
                         completion) {
                    if (args.size() > 0) {
                      juce::Logger::writeToLog("JS: " + args[0].toString());
                    }
                    completion(true);
                  })) {

  addAndMakeVisible(web_browser);

  juce::String html_string(embedded_ui_html);
  web_browser.goToURL("data:text/html;base64," +
                      juce::Base64::toBase64(html_string));

  setSize(800, 600);
  startTimer(2000);
}

MainComponent::~MainComponent() { stopTimer(); }
void MainComponent::timerCallback() {
  web_browser.evaluateJavascript("if(window.log) log('C++ Heartbeat');");
}
void MainComponent::paint(juce::Graphics &g) {
  g.fillAll(
      getLookAndFeel().findColour(juce::ResizableWindow::backgroundColourId));
}
void MainComponent::resized() { web_browser.setBounds(getLocalBounds()); }
void MainComponent::setupNativeFunctions() {}
