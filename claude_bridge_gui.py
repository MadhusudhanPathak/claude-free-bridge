import sys
import os
import json
import threading
import subprocess
import time
from urllib.request import urlopen, Request

try:
    from PyQt5 import QtWidgets, QtCore
except Exception:
    print('PyQt5 not installed. Install with: pip install PyQt5')
    sys.exit(1)

CONFIG_DIR = os.path.join(os.path.expanduser('~'), '.claude-free-bridge')
AUTH_PATH = os.path.join(CONFIG_DIR, 'auth.json')
PROFILES_ROOT = os.path.join(CONFIG_DIR, 'profiles')

class MainWindow(QtWidgets.QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle('Claude Free Bridge')
        self.resize(520, 240)
        layout = QtWidgets.QVBoxLayout()
        self.setLayout(layout)

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

        # Buttons
        btn_row = QtWidgets.QHBoxLayout()
        layout.addLayout(btn_row)
        self.btn_auth = QtWidgets.QPushButton('Authenticate')
        self.btn_auth.clicked.connect(self.run_auth)
        btn_row.addWidget(self.btn_auth)

        self.btn_serve = QtWidgets.QPushButton('Start Server')
        self.btn_serve.clicked.connect(self.run_server)
        btn_row.addWidget(self.btn_serve)

        self.btn_refresh = QtWidgets.QPushButton('Refresh')
        self.btn_refresh.clicked.connect(self.refresh)
        btn_row.addWidget(self.btn_refresh)

        # Minimal log
        self.log = QtWidgets.QTextEdit()
        self.log.setReadOnly(True)
        self.log.setFixedHeight(80)
        layout.addWidget(self.log)

        self.server_proc = None
        self.refresh()

    def append_log(self, text):
        ts = time.strftime('%H:%M:%S')
        self.log.append(f'[{ts}] {text}')

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
            except Exception as e:
                last_org = 'Error'
        self.val_last_org.setText(last_org)

        # server health
        try:
            req = Request('http://127.0.0.1:8080/health', headers={'User-Agent': 'claude-bridge-gui'})
            with urlopen(req, timeout=1) as r:
                txt = r.read().decode('utf8')
                self.val_server.setText('Running')
                self.append_log('Server up')
        except Exception:
            self.val_server.setText('Stopped')

    def run_auth(self):
        def _run():
            cwd = os.getcwd()
            if os.path.exists(os.path.join(cwd, 'dist', 'index.js')):
                cmd = ['node', os.path.join('dist', 'index.js'), 'auth-info', '--login']
            else:
                cmd = ['npx', 'ts-node', 'src/index.ts', 'auth-info', '--login']
            self.append_log('Auth: ' + ' '.join(cmd))
            try:
                p = subprocess.Popen(cmd)
                p.wait()
                self.append_log('Auth finished')
            except Exception as e:
                self.append_log('Auth failed: ' + str(e))
            self.refresh()
        threading.Thread(target=_run, daemon=True).start()

    def run_server(self):
        if self.server_proc:
            self.append_log('Server already running')
            return
        def _run():
            cwd = os.getcwd()
            if os.path.exists(os.path.join(cwd, 'dist', 'index.js')):
                cmd = ['node', os.path.join('dist', 'index.js'), 'serve']
            else:
                cmd = ['npx', 'ts-node', 'src/index.ts', 'serve']
            self.append_log('Starting server: ' + ' '.join(cmd))
            try:
                p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                self.server_proc = p
                # read a few lines
                while True:
                    line = p.stdout.readline()
                    if line:
                        self.append_log(line.strip())
                        if 'listening' in line.lower():
                            break
                    elif p.poll() is not None:
                        break
                    else:
                        time.sleep(0.1)
                self.append_log('Server started')
            except Exception as e:
                self.append_log('Server failed: ' + str(e))
            self.refresh()
        threading.Thread(target=_run, daemon=True).start()

if __name__ == '__main__':
    app = QtWidgets.QApplication(sys.argv)
    w = MainWindow()
    w.show()
    sys.exit(app.exec_())
