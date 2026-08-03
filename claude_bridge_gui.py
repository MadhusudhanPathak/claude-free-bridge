import sys
import os
import json
import threading
import subprocess
import time
import urllib.error
from urllib.request import urlopen, Request

try:
    from PyQt5 import QtWidgets, QtCore
except Exception:
    print('PyQt5 not installed. Install with: pip install PyQt5')
    sys.exit(1)

CONFIG_DIR = os.path.join(os.path.expanduser('~'), '.claude-free-bridge')
AUTH_PATH = os.path.join(CONFIG_DIR, 'auth.json')
PROFILES_ROOT = os.path.join(CONFIG_DIR, 'profiles')
SERVER_URL = 'http://127.0.0.1:8080'


class MainWindow(QtWidgets.QWidget):
    # Emitted from background threads; Qt marshals these onto the GUI thread automatically.
    log_signal = QtCore.pyqtSignal(str)
    refresh_signal = QtCore.pyqtSignal()

    def __init__(self):
        super().__init__()
        self.setWindowTitle('Claude Free Bridge')
        self.resize(640, 420)
        layout = QtWidgets.QVBoxLayout()
        self.setLayout(layout)

        self.log_signal.connect(self.append_log)
        self.refresh_signal.connect(self.refresh)

        # Info area (always visible)
        self.info_grid = QtWidgets.QGridLayout()
        layout.addLayout(self.info_grid)

        self.lbl_auth = QtWidgets.QLabel('Auth stored:')
        self.val_auth = QtWidgets.QLabel('Unknown')
        self.info_grid.addWidget(self.lbl_auth, 0, 0)
        self.info_grid.addWidget(self.val_auth, 0, 1)

        self.lbl_last_org = QtWidgets.QLabel('lastActiveOrg:')
        self.val_last_org = QtWidgets.QLabel('Unknown')
        self.info_grid.addWidget(self.lbl_last_org, 1, 0)
        self.info_grid.addWidget(self.val_last_org, 1, 1)

        self.lbl_profiles = QtWidgets.QLabel('Profiles:')
        self.val_profiles = QtWidgets.QLabel('0')
        self.info_grid.addWidget(self.lbl_profiles, 2, 0)
        self.info_grid.addWidget(self.val_profiles, 2, 1)

        self.lbl_server = QtWidgets.QLabel('Server:')
        self.val_server = QtWidgets.QLabel('Stopped')
        self.info_grid.addWidget(self.lbl_server, 3, 0)
        self.info_grid.addWidget(self.val_server, 3, 1)

        # Step 1: build
        row1 = QtWidgets.QHBoxLayout()
        layout.addLayout(row1)
        self.btn_build = QtWidgets.QPushButton('1. Build')
        self.btn_build.clicked.connect(self.run_build)
        row1.addWidget(self.btn_build)

        self.btn_auth = QtWidgets.QPushButton('2. Authenticate (login)')
        self.btn_auth.clicked.connect(self.run_auth)
        row1.addWidget(self.btn_auth)

        self.btn_import_session = QtWidgets.QPushButton('2b. Import Session Cookie')
        self.btn_import_session.clicked.connect(self.run_import_session)
        row1.addWidget(self.btn_import_session)

        self.btn_auth_info = QtWidgets.QPushButton('3. Show Auth Info')
        self.btn_auth_info.clicked.connect(self.run_auth_info)
        row1.addWidget(self.btn_auth_info)

        # Step 4: probe
        row2 = QtWidgets.QHBoxLayout()
        layout.addLayout(row2)
        self.btn_probe = QtWidgets.QPushButton('4. Probe (single prompt)')
        self.btn_probe.clicked.connect(self.run_probe)
        row2.addWidget(self.btn_probe)

        # Step 5: server controls
        self.btn_serve = QtWidgets.QPushButton('5. Start Server')
        self.btn_serve.clicked.connect(self.run_server)
        row2.addWidget(self.btn_serve)

        self.btn_stop_serve = QtWidgets.QPushButton('Stop Server')
        self.btn_stop_serve.clicked.connect(self.stop_server)
        row2.addWidget(self.btn_stop_serve)

        # Step 6: API test + integration tests
        row3 = QtWidgets.QHBoxLayout()
        layout.addLayout(row3)
        self.btn_test_chat = QtWidgets.QPushButton('6. Test Chat API')
        self.btn_test_chat.clicked.connect(self.test_chat_api)
        row3.addWidget(self.btn_test_chat)

        self.btn_integration = QtWidgets.QPushButton('7. Run Integration Tests')
        self.btn_integration.clicked.connect(self.run_integration)
        row3.addWidget(self.btn_integration)

        self.btn_refresh = QtWidgets.QPushButton('Refresh')
        self.btn_refresh.clicked.connect(self.refresh)
        row3.addWidget(self.btn_refresh)

        # Log
        self.log = QtWidgets.QTextEdit()
        self.log.setReadOnly(True)
        layout.addWidget(self.log)

        self.server_proc = None
        self.refresh()

    # --- helpers -----------------------------------------------------

    def append_log(self, text):
        ts = time.strftime('%H:%M:%S')
        self.log.append(f'[{ts}] {text}')

    def cli_command(self, *args):
        cwd = os.getcwd()
        if os.path.exists(os.path.join(cwd, 'dist', 'index.js')):
            return ['node', os.path.join('dist', 'index.js'), *args]
        return ['npx', 'ts-node', 'src/index.ts', *args]

    def run_in_background(self, fn):
        threading.Thread(target=fn, daemon=True).start()

    # --- info panel ----------------------------------------------------

    def refresh(self):
        auth_exists = os.path.exists(AUTH_PATH)
        self.val_auth.setText('Yes' if auth_exists else 'No')

        profiles = []
        if os.path.exists(PROFILES_ROOT):
            try:
                profiles = os.listdir(PROFILES_ROOT)
            except Exception:
                profiles = []
        self.val_profiles.setText(str(len(profiles)))

        last_org = 'Unknown'
        if auth_exists:
            try:
                with open(AUTH_PATH, 'r', encoding='utf8') as f:
                    data = json.load(f)
                    cookies = data.get('cookies') or []
                    for c in cookies:
                        if c.get('name') == 'lastActiveOrg':
                            last_org = c.get('value')
                            break
            except Exception:
                last_org = 'Error'
        self.val_last_org.setText(last_org)

        try:
            req = Request(f'{SERVER_URL}/health', headers={'User-Agent': 'claude-bridge-gui'})
            with urlopen(req, timeout=1) as r:
                r.read()
                self.val_server.setText('Running')
        except Exception:
            self.val_server.setText('Stopped')

    # --- step 1: build ---------------------------------------------------

    def run_build(self):
        def _run():
            self.log_signal.emit('Building (npm run build)...')
            try:
                p = subprocess.Popen(['npm', 'run', 'build'], stdout=subprocess.PIPE,
                                      stderr=subprocess.STDOUT, text=True, shell=(os.name == 'nt'))
                for line in p.stdout:
                    self.log_signal.emit(line.rstrip())
                p.wait()
                self.log_signal.emit('Build finished with exit code ' + str(p.returncode))
            except Exception as e:
                self.log_signal.emit('Build failed: ' + str(e))
        self.run_in_background(_run)

    # --- step 2/3: auth ---------------------------------------------------

    def detect_browsers(self):
        cmd = self.cli_command('list-browsers', '--json')
        try:
            out = subprocess.check_output(cmd, text=True, timeout=15)
            return json.loads(out)
        except Exception as e:
            self.append_log('Could not detect browsers: ' + str(e))
            return [{'id': 'bundled', 'label': 'Automated Chromium (bundled)', 'kind': 'bundled'}]

    def run_auth(self):
        browsers = self.detect_browsers()
        labels = [b['label'] for b in browsers]
        choice, ok = QtWidgets.QInputDialog.getItem(
            self, 'Select browser', 'Use which browser for login?', labels, 0, False
        )
        if not ok:
            return
        browser_id = browsers[labels.index(choice)]['id']

        def _run():
            cmd = self.cli_command('auth-info', '--login', '--browser', browser_id)
            self.log_signal.emit('Auth using "%s" (opens a browser window — complete login there): %s' % (choice, ' '.join(cmd)))
            try:
                p = subprocess.Popen(cmd)
                p.wait()
                self.log_signal.emit('Auth process finished')
            except Exception as e:
                self.log_signal.emit('Auth failed: ' + str(e))
            self.refresh_signal.emit()
        self.run_in_background(_run)

    def run_import_session(self):
        text, ok = QtWidgets.QInputDialog.getText(
            self, 'Import session cookie',
            'Paste the "sessionKey" cookie value from your normal browser\n'
            '(DevTools > Application > Storage > Cookies > https://claude.ai > sessionKey):'
        )
        if not ok or not text.strip():
            return

        def _run():
            cmd = self.cli_command('auth-set-session', text.strip())
            self.log_signal.emit('Importing session cookie...')
            try:
                p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                for line in p.stdout:
                    self.log_signal.emit(line.rstrip())
                p.wait()
            except Exception as e:
                self.log_signal.emit('Import failed: ' + str(e))
            self.refresh_signal.emit()
        self.run_in_background(_run)

    def run_auth_info(self):
        def _run():
            cmd = self.cli_command('auth-info')
            self.log_signal.emit('Checking auth: ' + ' '.join(cmd))
            try:
                p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                for line in p.stdout:
                    self.log_signal.emit(line.rstrip())
                p.wait()
            except Exception as e:
                self.log_signal.emit('auth-info failed: ' + str(e))
            self.refresh_signal.emit()
        self.run_in_background(_run)

    # --- step 4: probe -----------------------------------------------------

    def run_probe(self):
        prompt, ok = QtWidgets.QInputDialog.getText(self, 'Probe prompt', 'Prompt to send:', text='Say hello')
        if not ok or not prompt.strip():
            return

        def _run():
            cmd = self.cli_command('probe', prompt, '--headed')
            self.log_signal.emit('Probe: ' + ' '.join(cmd))
            try:
                p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                for line in p.stdout:
                    self.log_signal.emit(line.rstrip())
                p.wait()
                self.log_signal.emit('Probe finished with exit code ' + str(p.returncode))
            except Exception as e:
                self.log_signal.emit('Probe failed: ' + str(e))
        self.run_in_background(_run)

    # --- step 5: server control ---------------------------------------------

    def run_server(self):
        if self.server_proc and self.server_proc.poll() is None:
            self.append_log('Server already running')
            return

        def _run():
            cmd = self.cli_command('serve')
            self.log_signal.emit('Starting server: ' + ' '.join(cmd))
            try:
                p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                self.server_proc = p
                for line in p.stdout:
                    self.log_signal.emit(line.rstrip())
                    if 'listening' in line.lower():
                        self.refresh_signal.emit()
                # keep draining output for the life of the process
            except Exception as e:
                self.log_signal.emit('Server failed: ' + str(e))
            self.refresh_signal.emit()
        self.run_in_background(_run)

    def stop_server(self):
        if not self.server_proc or self.server_proc.poll() is not None:
            self.append_log('Server is not running')
            self.refresh()
            return
        self.append_log('Stopping server...')
        try:
            self.server_proc.terminate()
            self.server_proc.wait(timeout=5)
        except Exception:
            try:
                self.server_proc.kill()
            except Exception:
                pass
        self.server_proc = None
        self.refresh()

    # --- step 6: API smoke test ---------------------------------------------

    def test_chat_api(self):
        def _run():
            body = json.dumps({
                'model': 'claude-3.5-web',
                'messages': [{'role': 'user', 'content': 'Say hello in one short sentence'}],
                'stream': False,
            }).encode('utf8')
            req = Request(f'{SERVER_URL}/v1/chat/completions', data=body,
                           headers={'Content-Type': 'application/json'}, method='POST')
            self.log_signal.emit('POST /v1/chat/completions ...')
            try:
                with urlopen(req, timeout=180) as r:
                    txt = r.read().decode('utf8')
                    self.log_signal.emit(f'Response ({r.status}): {txt}')
            except urllib.error.HTTPError as e:
                self.log_signal.emit(f'HTTP error {e.code}: {e.read().decode("utf8", "ignore")}')
            except Exception as e:
                self.log_signal.emit('Chat API test failed: ' + str(e))
        self.run_in_background(_run)

    # --- step 7: integration tests -------------------------------------------

    def run_integration(self):
        def _run():
            self.log_signal.emit('Running npm run integration (starts its own server instance)...')
            try:
                p = subprocess.Popen(['npm', 'run', 'integration'], stdout=subprocess.PIPE,
                                      stderr=subprocess.STDOUT, text=True, shell=(os.name == 'nt'))
                for line in p.stdout:
                    self.log_signal.emit(line.rstrip())
                p.wait()
                self.log_signal.emit('Integration tests finished with exit code ' + str(p.returncode))
            except Exception as e:
                self.log_signal.emit('Integration run failed: ' + str(e))
        self.run_in_background(_run)

    # --- lifecycle -----------------------------------------------------------

    def closeEvent(self, event):
        if self.server_proc and self.server_proc.poll() is None:
            try:
                self.server_proc.terminate()
            except Exception:
                pass
        event.accept()


if __name__ == '__main__':
    app = QtWidgets.QApplication(sys.argv)
    w = MainWindow()
    w.show()
    sys.exit(app.exec_())
