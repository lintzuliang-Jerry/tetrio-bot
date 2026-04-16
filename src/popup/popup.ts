const btnStart = document.getElementById('btn-start') as HTMLButtonElement;
const btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
const statusDot = document.getElementById('status-dot') as HTMLDivElement;
const statusText = document.getElementById('status-text') as HTMLSpanElement;
const speedSelect = document.getElementById('speed-select') as HTMLSelectElement;
const speedLabel = document.getElementById('speed-label') as HTMLSpanElement;
const strengthSelect = document.getElementById('strength-select') as HTMLSelectElement;
const strengthLabel = document.getElementById('strength-label') as HTMLSpanElement;
const weightsSelect = document.getElementById('weights-select') as HTMLSelectElement;
const weightsLabel = document.getElementById('weights-label') as HTMLSpanElement;
const statPieces = document.getElementById('stat-pieces') as HTMLSpanElement;
const statPps = document.getElementById('stat-pps') as HTMLSpanElement;

let running = false;

function updateUI(status: { running: boolean; connected: boolean; piecesPlaced: number; pps: number }) {
  running = status.running;

  statusDot.classList.toggle('connected', status.connected);
  statusText.textContent = status.connected
    ? (status.running ? '運行中' : '已連線')
    : '未連線';

  btnStart.disabled = status.running;
  btnStop.disabled = !status.running;

  statPieces.textContent = String(status.piecesPlaced);
  statPps.textContent = status.pps.toFixed(1);
}

function sendMessage(msg: { type: string; payload?: unknown }): Promise<unknown> {
  return chrome.runtime.sendMessage(msg);
}

// Poll status
function pollStatus(): void {
  sendMessage({ type: 'GET_STATUS' })
    .then((res) => {
      if (res && typeof res === 'object') {
        updateUI(res as { running: boolean; connected: boolean; piecesPlaced: number; pps: number });
      }
    })
    .catch(() => {/* tab not available */});
}

btnStart.addEventListener('click', () => {
  sendMessage({ type: 'BOT_START' }).catch(() => {});
  btnStart.disabled = true;
  btnStop.disabled = false;
  statusText.textContent = '運行中';
});

btnStop.addEventListener('click', () => {
  sendMessage({ type: 'BOT_STOP' }).catch(() => {});
  btnStart.disabled = false;
  btnStop.disabled = true;
  statusText.textContent = '已停止';
});

speedSelect.addEventListener('change', () => {
  const val = speedSelect.value;
  speedLabel.textContent = val.charAt(0).toUpperCase() + val.slice(1);
  sendMessage({ type: 'SET_SPEED', payload: { preset: val } }).catch(() => {});
});

strengthSelect.addEventListener('change', () => {
  const val = strengthSelect.value;
  strengthLabel.textContent = val.charAt(0).toUpperCase() + val.slice(1);
  sendMessage({ type: 'SET_STRENGTH', payload: { strength: val } }).catch(() => {});
});

weightsSelect.addEventListener('change', () => {
  const val = weightsSelect.value;
  weightsLabel.textContent = val.charAt(0).toUpperCase() + val.slice(1);
  sendMessage({ type: 'SET_WEIGHTS', payload: { profile: val } }).catch(() => {});
});

// Poll every second
setInterval(pollStatus, 1000);
pollStatus();
