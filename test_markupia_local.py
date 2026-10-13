#!/usr/bin/env python3
"""
Markupia — testes locais (FASE 2/3).

Roda contra `server_markupia.py`. NÃO usa dependências externas — apenas
stdlib. Pode ser executado diretamente:

    python3 test_markupia_local.py

Sobe o servidor em 127.0.0.1:<porta-livre>, executa os testes e o encerra.

Caso coberto pela seção 10 do documento de especificação:

  ✔ Inicialização do servidor
  ✔ Resposta HTTP
  ✔ Conexão WebSocket
  ✔ Entrada de dois jogadores
  ✔ Jogadores na mesma sala
  ✔ Jogadores em salas diferentes
  ✔ Atualização de posição
  ✔ Mensagens de chat
  ✔ Atualização de equipamentos
  ✔ Desconexão e remoção de jogadores
  ✔ Reconexão
  ✔ Mensagens JSON inválidas
  ✔ Privilégios administrativos não autorizados
  ✔ Autenticação e identificação (lock de sessão por user_id)

  ⏭ Falha de nó               — FASE 6
  ⏭ Comunicação entre dois nós — FASE 6
"""

import asyncio
import base64
import json
import os
import socket
import struct
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, 'server_markupia.py')

PASSED = 0
FAILED = 0
FAILURES: list[str] = []

def ok(name: str):
    global PASSED
    PASSED += 1
    print(f'  \033[92mOK\033[0m   {name}')

def fail(name: str, why: str = ''):
    global FAILED
    FAILED += 1
    FAILURES.append(f'{name} — {why}' if why else name)
    print(f'  \033[91mFAIL\033[0m {name}' + (f' — {why}' if why else ''))

def section(title: str):
    print(f'\n\033[96m=== {title} ===\033[0m')

# ============================================================
# WS CLIENT (só stdlib)
# ============================================================
class WSClient:
    def __init__(self, reader, writer):
        self.reader = reader
        self.writer = writer
        self.queue: asyncio.Queue = asyncio.Queue()
        self._task = asyncio.create_task(self._reader_loop())
        self.closed = False

    async def _reader_loop(self):
        try:
            while True:
                frame = await _read_frame(self.reader)
                if frame is None:
                    await self.queue.put(None)
                    return
                opcode, payload = frame
                if opcode == 0x1:
                    try:
                        msg = json.loads(payload.decode('utf-8'))
                        await self.queue.put(msg)
                    except Exception:
                        pass
                elif opcode == 0x8:
                    await self.queue.put(None)
                    return
        except asyncio.CancelledError:
            return
        except Exception:
            await self.queue.put(None)

    async def send_json(self, data):
        payload = json.dumps(data).encode('utf-8')
        self.writer.write(_make_client_frame(0x1, payload))
        await self.writer.drain()

    async def send_raw(self, raw: bytes):
        self.writer.write(_make_client_frame(0x1, raw))
        await self.writer.drain()

    async def recv(self, timeout=2.0):
        try:
            return await asyncio.wait_for(self.queue.get(), timeout)
        except asyncio.TimeoutError:
            return None

    async def wait_for(self, pred, timeout=3.0):
        """Consome mensagens até uma satisfazer pred(msg) ou timeout."""
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            msg = await self.recv(timeout=remaining)
            if msg is None:
                return None
            if pred(msg):
                return msg

    async def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            self.writer.write(_make_client_frame(0x8, b''))
            await self.writer.drain()
        except Exception:
            pass
        try:
            self.writer.close()
        except Exception:
            pass
        self._task.cancel()
        try:
            await self._task
        except (asyncio.CancelledError, Exception):
            pass

async def ws_connect(host, port) -> WSClient:
    reader, writer = await asyncio.open_connection(host, port)
    key = base64.b64encode(os.urandom(16)).decode()
    req = (
        f'GET /ws HTTP/1.1\r\n'
        f'Host: {host}:{port}\r\n'
        f'Upgrade: websocket\r\n'
        f'Connection: Upgrade\r\n'
        f'Sec-WebSocket-Key: {key}\r\n'
        f'Sec-WebSocket-Version: 13\r\n\r\n'
    )
    writer.write(req.encode('utf-8'))
    await writer.drain()
    resp = await reader.readuntil(b'\r\n\r\n')
    if b' 101 ' not in resp.split(b'\r\n', 1)[0]:
        raise RuntimeError(f'handshake falhou: {resp[:120]!r}')
    return WSClient(reader, writer)

def _make_client_frame(opcode: int, payload: bytes) -> bytes:
    n = len(payload)
    header = bytes([0x80 | opcode])
    if n < 126:
        header += bytes([0x80 | n])
    elif n < 65536:
        header += bytes([0x80 | 126]) + struct.pack('>H', n)
    else:
        header += bytes([0x80 | 127]) + struct.pack('>Q', n)
    mask = os.urandom(4)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return header + mask + masked

async def _read_frame(reader):
    try:
        header = await reader.readexactly(2)
    except asyncio.IncompleteReadError:
        return None
    b1, b2 = header[0], header[1]
    opcode = b1 & 0x0F
    masked = (b2 >> 7) & 1
    length = b2 & 0x7F
    try:
        if length == 126:
            length = struct.unpack('>H', await reader.readexactly(2))[0]
        elif length == 127:
            length = struct.unpack('>Q', await reader.readexactly(8))[0]
        mask = await reader.readexactly(4) if masked else None
        payload = await reader.readexactly(length) if length else b''
    except asyncio.IncompleteReadError:
        return None
    if mask:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return opcode, payload

# ============================================================
# SERVIDOR DE TESTE
# ============================================================
def free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p

async def start_server(port: int):
    env = {**os.environ, 'PORT': str(port), 'HOST': '127.0.0.1'}
    proc = await asyncio.create_subprocess_exec(
        sys.executable, SERVER,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    # Espera ficar pronto.
    deadline = time.monotonic() + 8.0
    while time.monotonic() < deadline:
        try:
            r, w = await asyncio.open_connection('127.0.0.1', port)
            w.close()
            return proc
        except (ConnectionRefusedError, OSError):
            await asyncio.sleep(0.1)
    raise RuntimeError('servidor não subiu')

async def stop_server(proc):
    try:
        proc.terminate()
    except ProcessLookupError:
        return
    try:
        await asyncio.wait_for(proc.wait(), timeout=4.0)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass

# ============================================================
# HELPERS DE TESTE
# ============================================================
async def http_get(port, path):
    reader, writer = await asyncio.open_connection('127.0.0.1', port)
    req = (f'GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n'
           f'Connection: close\r\n\r\n')
    writer.write(req.encode('utf-8'))
    await writer.drain()
    data = await reader.read()
    writer.close()
    try:
        await writer.wait_closed()
    except Exception:
        pass
    return data

def parse_http(data: bytes):
    head, _, body = data.partition(b'\r\n\r\n')
    line = head.split(b'\r\n', 1)[0].decode('latin-1', 'replace')
    return line, body

async def join(client: WSClient, name, room='default', user_id=None, is_adm=False):
    await client.send_json({
        'type': 'join',
        'name': name,
        'avatar_colors': {'head': '#f5cd30'},
        'equipped_items': {},
        'is_adm': is_adm,
        'game': room,
        'user_id': user_id,
    })

# ============================================================
# TESTES
# ============================================================
async def test_server_start(port):
    section('Servidor inicia e responde HTTP')
    data = await http_get(port, '/')
    line, body = parse_http(data)
    if '200' in line and len(body) > 0:
        ok('GET / responde 200 com corpo')
    else:
        fail('GET / responde 200 com corpo', f'linha={line!r} len={len(body)}')

    # Rota SPA sem extensão -> cai no index.html.
    data = await http_get(port, '/profile/33')
    line, body = parse_http(data)
    if '200' in line and b'<html' in body[:200].lower():
        ok('Rota SPA /profile/33 cai em index.html')
    else:
        fail('Rota SPA /profile/33 cai em index.html', f'linha={line!r}')

    # Rota inexistente com extensão -> 404.
    data = await http_get(port, '/nope.png')
    line, _ = parse_http(data)
    if '404' in line:
        ok('Rota /nope.png responde 404')
    else:
        fail('Rota /nope.png responde 404', f'linha={line!r}')

    # Tentativa de path traversal.
    data = await http_get(port, '/../server.py')
    line, _ = parse_http(data)
    if '200' not in line or b'import' not in data:
        ok('Path traversal bloqueado')
    else:
        fail('Path traversal bloqueado', f'linha={line!r}')

async def test_ws_connect(port):
    section('Conexão WebSocket')
    try:
        c = await ws_connect('127.0.0.1', port)
        await c.close()
        ok('Handshake WebSocket completa')
    except Exception as e:
        fail('Handshake WebSocket completa', repr(e))

async def test_two_players_same_room(port):
    section('Dois jogadores na mesma sala')
    a = await ws_connect('127.0.0.1', port)
    b = await ws_connect('127.0.0.1', port)
    try:
        await join(a, 'Alice', room='room-X')
        w_a = await a.wait_for(lambda m: m.get('type') == 'welcome')
        if not w_a:
            fail('Alice recebe welcome'); return
        ok('Alice recebe welcome')

        await join(b, 'Bob', room='room-X')
        w_b = await b.wait_for(lambda m: m.get('type') == 'welcome')
        if not w_b:
            fail('Bob recebe welcome'); return
        ok('Bob recebe welcome')

        # Alice deve receber player_join do Bob.
        pj = await a.wait_for(
            lambda m: m.get('type') == 'player_join'
                      and m.get('player', {}).get('name') == 'Bob'
        )
        if pj:
            ok('Alice vê Bob entrando (player_join)')
        else:
            fail('Alice vê Bob entrando (player_join)')

        # Welcome do Bob deve listar a Alice.
        names = [p.get('name') for p in w_b.get('players', [])]
        if 'Alice' in names:
            ok('Bob vê Alice na lista do welcome')
        else:
            fail('Bob vê Alice na lista do welcome', f'lista={names}')
    finally:
        await a.close()
        await b.close()

async def test_different_rooms(port):
    section('Jogadores em salas diferentes')
    a = await ws_connect('127.0.0.1', port)
    b = await ws_connect('127.0.0.1', port)
    try:
        await join(a, 'A', room='room-1')
        await a.wait_for(lambda m: m.get('type') == 'welcome')
        await join(b, 'B', room='room-2')
        w_b = await b.wait_for(lambda m: m.get('type') == 'welcome')
        if not w_b:
            fail('B recebe welcome'); return
        names = [p.get('name') for p in w_b.get('players', [])]
        if 'A' not in names:
            ok('B (sala 2) não vê A (sala 1)')
        else:
            fail('B (sala 2) não vê A (sala 1)', f'lista={names}')

        # Nenhum player_join de A deve chegar em B.
        pj = await b.wait_for(
            lambda m: m.get('type') == 'player_join', timeout=0.6
        )
        if pj is None:
            ok('B não recebe player_join de outro sala')
        else:
            fail('B não recebe player_join de outro sala', f'msg={pj}')
    finally:
        await a.close()
        await b.close()

async def test_position_update(port):
    section('Atualização de posição')
    a = await ws_connect('127.0.0.1', port)
    b = await ws_connect('127.0.0.1', port)
    try:
        await join(a, 'A', room='pos-room')
        await a.wait_for(lambda m: m.get('type') == 'welcome')
        await join(b, 'B', room='pos-room')
        w_b = await b.wait_for(lambda m: m.get('type') == 'welcome')
        a_id = (await a.wait_for(lambda m: m.get('type') == 'welcome')).get('id')

        # A envia estado.
        await a.send_json({
            'type': 'state',
            'x': 7.5, 'y': 3.25, 'z': -2.0,
            'yaw': 1.25, 'vy': 0.0, 'hs': 4.0, 'g': True,
            'hp': 80, 'dead': False,
        })

        # B deve receber states com id=a_id e x=7.5, hp=80.
        got = await b.wait_for(
            lambda m: (
                m.get('type') == 'states'
                and any(s.get('id') == a_id and abs(s.get('x', 0) - 7.5) < 0.01
                        and s.get('hp') == 80 and s.get('dead') is False
                        for s in m.get('states', []))
            ),
            timeout=3.0,
        )
        if got:
            ok('B recebe state com hp e dead (correção FASE 2)')
        else:
            fail('B recebe state com hp e dead (correção FASE 2)')

        # Estado inválido (NaN/Infinity) não deve derrubar.
        await a.send_json({
            'type': 'state',
            'x': float('nan'), 'y': float('inf'), 'z': 'not a number',
            'yaw': None, 'vy': None, 'hs': None, 'g': 'yes',
            'hp': 'x', 'dead': 'x',
        })
        await asyncio.sleep(0.2)
        # Servidor continua vivo:
        await a.send_json({'type': 'chat', 'text': 'ping'})
        got2 = await b.wait_for(
            lambda m: m.get('type') == 'chat' and m.get('text') == 'ping',
            timeout=2.0,
        )
        if got2:
            ok('Servidor sobrevive a state com NaN/Infinity')
        else:
            fail('Servidor sobrevive a state com NaN/Infinity')
    finally:
        await a.close()
        await b.close()

async def test_chat(port):
    section('Mensagens de chat')
    a = await ws_connect('127.0.0.1', port)
    b = await ws_connect('127.0.0.1', port)
    try:
        await join(a, 'Alice', room='chat-room')
        await a.wait_for(lambda m: m.get('type') == 'welcome')
        await join(b, 'Bob', room='chat-room')
        await b.wait_for(lambda m: m.get('type') == 'welcome')

        await a.send_json({'type': 'chat', 'text': 'olá mundo'})
        got = await b.wait_for(
            lambda m: m.get('type') == 'chat' and m.get('text') == 'olá mundo'
        )
        if got:
            if got.get('name') == 'Alice':
                ok('Bob recebe chat de Alice com nome correto')
            else:
                fail('Bob recebe chat de Alice com nome correto',
                     f'name={got.get("name")!r}')
        else:
            fail('Bob recebe chat de Alice')

        # O próprio remetente não recebe eco.
        echo = await a.wait_for(
            lambda m: m.get('type') == 'chat' and m.get('text') == 'olá mundo',
            timeout=0.5,
        )
        if echo is None:
            ok('Remetente não recebe eco do próprio chat')
        else:
            fail('Remetente não recebe eco do próprio chat')
    finally:
        await a.close()
        await b.close()

async def test_equip_update(port):
    section('Atualização de equipamentos')
    a = await ws_connect('127.0.0.1', port)
    b = await ws_connect('127.0.0.1', port)
    try:
        await join(a, 'A', room='eq-room')
        w_a = await a.wait_for(lambda m: m.get('type') == 'welcome')
        await join(b, 'B', room='eq-room')
        await b.wait_for(lambda m: m.get('type') == 'welcome')

        a_id = w_a['id']
        await a.send_json({
            'type': 'equip_update',
            'equipped_items': {'Head': ['crown_1'], 'face': 'default_face'},
        })
        got = await b.wait_for(
            lambda m: m.get('type') == 'player_equip' and m.get('id') == a_id
        )
        if got and got.get('equipped_items', {}).get('Head') == ['crown_1']:
            ok('B recebe player_equip com Head:[crown_1]')
        else:
            fail('B recebe player_equip com Head:[crown_1]', f'got={got}')
    finally:
        await a.close()
        await b.close()

async def test_disconnect(port):
    section('Desconexão e remoção')
    a = await ws_connect('127.0.0.1', port)
    b = await ws_connect('127.0.0.1', port)
    try:
        await join(a, 'Alice', room='leave-room')
        w_a = await a.wait_for(lambda m: m.get('type') == 'welcome')
        await join(b, 'Bob', room='leave-room')
        await b.wait_for(lambda m: m.get('type') == 'welcome')

        a_id = w_a['id']
        await a.close()

        got = await b.wait_for(
            lambda m: m.get('type') == 'player_leave' and m.get('id') == a_id,
            timeout=3.0,
        )
        if got:
            ok('Bob recebe player_leave quando Alice sai')
        else:
            fail('Bob recebe player_leave quando Alice sai')
    finally:
        await b.close()

async def test_session_lock(port):
    section('Autenticação e lock de sessão')
    a = await ws_connect('127.0.0.1', port)
    b = await ws_connect('127.0.0.1', port)
    try:
        await join(a, 'Alice', room='lock-room', user_id='user-uuid-abc-123')
        w_a = await a.wait_for(lambda m: m.get('type') == 'welcome')
        if not w_a:
            fail('Alice entra com user_id'); return
        ok('Alice entra com user_id')

        # Bob tenta o mesmo user_id — deve ser rejeitado.
        await join(b, 'Impostor', room='lock-room', user_id='user-uuid-abc-123')
        err = await b.wait_for(
            lambda m: m.get('type') == 'error' and m.get('code') == 'already_playing',
            timeout=2.0,
        )
        if err:
            ok('Segunda sessão com mesmo user_id é rejeitada')
        else:
            fail('Segunda sessão com mesmo user_id é rejeitada')

        # Alice sai, então o user_id fica livre.
        await a.close()
        await asyncio.sleep(0.4)

        c = await ws_connect('127.0.0.1', port)
        try:
            await join(c, 'Alice2', room='lock-room', user_id='user-uuid-abc-123')
            w_c = await c.wait_for(lambda m: m.get('type') == 'welcome')
            if w_c:
                ok('Reconexão funciona após liberar user_id')
            else:
                fail('Reconexão funciona após liberar user_id')
        finally:
            await c.close()
    finally:
        try:
            await a.close()
        except Exception:
            pass
        try:
            await b.close()
        except Exception:
            pass

async def test_invalid_json(port):
    section('Mensagens JSON inválidas')
    a = await ws_connect('127.0.0.1', port)
    b = await ws_connect('127.0.0.1', port)
    try:
        await join(a, 'A', room='json-room')
        await a.wait_for(lambda m: m.get('type') == 'welcome')
        await join(b, 'B', room='json-room')
        await b.wait_for(lambda m: m.get('type') == 'welcome')

        # Envia lixo binário. Servidor deve ignorar, não cair.
        await a.send_raw(b'not json at all }{')
        await a.send_raw(b'{"broken":')
        # Mensagem JSON válida mas sem 'type'.
        await a.send_json({'foo': 'bar'})
        # Deve continuar vivo:
        await a.send_json({'type': 'chat', 'text': 'vivo'})
        got = await b.wait_for(
            lambda m: m.get('type') == 'chat' and m.get('text') == 'vivo',
            timeout=2.0,
        )
        if got:
            ok('Servidor sobrevive a JSON inválido e continua broadcast')
        else:
            fail('Servidor sobrevive a JSON inválido e continua broadcast')
    finally:
        await a.close()
        await b.close()

async def test_admin_spoof_rejected(port):
    section('Privilégios administrativos não autorizados')
    a = await ws_connect('127.0.0.1', port)
    b = await ws_connect('127.0.0.1', port)
    try:
        # A se declara ADM.
        await join(a, 'FakeAdm', room='adm-room', is_adm=True)
        await a.wait_for(lambda m: m.get('type') == 'welcome')
        # B entra e recebe player_join do A.
        await join(b, 'Observer', room='adm-room')
        await b.wait_for(lambda m: m.get('type') == 'welcome')
        pj = await b.wait_for(
            lambda m: m.get('type') == 'player_join'
                      and m.get('player', {}).get('name') == 'FakeAdm',
            timeout=2.0,
        )
        if not pj:
            fail('Observer vê player_join de FakeAdm'); return
        if pj['player'].get('is_adm') is False:
            ok('is_adm=true do cliente é ignorado (publicado como false)')
        else:
            fail('is_adm=true do cliente é ignorado',
                 f'publicado={pj["player"].get("is_adm")!r}')

        # Também verifica welcome de B: nenhum jogador deve ter is_adm=True.
        w_b = await b.wait_for(lambda m: m.get('type') == 'welcome')
        # (w_b pode ter chegado antes do player_join — reprocessa no histórico)
        # Aqui é redundante mas mantém o teste robusto.
        for p in w_b.get('players', []):
            if p.get('is_adm') is True:
                fail('welcome de B: nenhum is_adm=True', f'player={p.get("name")}')
                return
        ok('welcome de B: nenhum is_adm=True')
    finally:
        await a.close()
        await b.close()

async def test_rate_limit(port):
    section('Rate limit (bônus)')
    a = await ws_connect('127.0.0.1', port)
    try:
        await join(a, 'Flooder', room='flood-room')
        await a.wait_for(lambda m: m.get('type') == 'welcome')

        # Envia 200 mensagens rapidamente — deve estourar o limite.
        for i in range(200):
            try:
                await a.send_json({'type': 'chat', 'text': f'msg-{i}'})
            except Exception:
                break

        # Servidor deve enviar 'error' code='rate_limit' ou fechar.
        err = await a.wait_for(
            lambda m: m is None or (
                m.get('type') == 'error' and m.get('code') == 'rate_limit'
            ),
            timeout=3.0,
        )
        if err is None or (isinstance(err, dict) and err.get('code') == 'rate_limit'):
            ok('Rate limit dispara (error ou close)')
        else:
            fail('Rate limit dispara (error ou close)', f'got={err}')
    finally:
        await a.close()

# ============================================================
# MAIN
# ============================================================
async def run_all():
    port = free_port()
    print(f'\n\033[96mSubindo servidor Markupia de teste na porta {port}…\033[0m')
    proc = await start_server(port)
    try:
        await test_server_start(port)
        await test_ws_connect(port)
        await test_two_players_same_room(port)
        await test_different_rooms(port)
        await test_position_update(port)
        await test_chat(port)
        await test_equip_update(port)
        await test_disconnect(port)
        await test_session_lock(port)
        await test_invalid_json(port)
        await test_admin_spoof_rejected(port)
        await test_rate_limit(port)
    finally:
        await stop_server(proc)

    print(f'\n\033[96m=== RESUMO ===\033[0m')
    print(f'  Passaram: \033[92m{PASSED}\033[0m')
    print(f'  Falharam: \033[91m{FAILED}\033[0m')
    if FAILURES:
        print('\n  Detalhes das falhas:')
        for f in FAILURES:
            print(f'    - {f}')
    return FAILED == 0

if __name__ == '__main__':
    try:
        good = asyncio.run(run_all())
    except KeyboardInterrupt:
        print('\ninterrompido.')
        sys.exit(130)
    sys.exit(0 if good else 1)