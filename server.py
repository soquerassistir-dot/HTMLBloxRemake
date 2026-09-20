#!/usr/bin/env python3

import asyncio
import base64
import hashlib
import json
import os
import struct
import time

HOST = '0.0.0.0'
PORT = int(os.environ.get('PORT', 8000))
WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
ROOT = os.path.dirname(os.path.abspath(__file__))

# ============================================================
# Estado global
# ============================================================
clients = {}            # player_id -> ClientState
next_player_id = 1
active_users = {}       # user_id -> player_id

# ============================================================
# WebSocket helpers
# ============================================================
def ws_accept(key):
    return base64.b64encode(
        hashlib.sha1((key + WS_MAGIC).encode()).digest()
    ).decode()

async def ws_read_frame(reader):
    try:
        header = await reader.readexactly(2)
    except (asyncio.IncompleteReadError, ConnectionError, OSError):
        return None
    b1, b2 = header[0], header[1]
    opcode = b1 & 0x0F
    masked = (b2 >> 7) & 1
    length = b2 & 0x7F
    if length == 126:
        try:
            length = struct.unpack('>H', await reader.readexactly(2))[0]
        except asyncio.IncompleteReadError:
            return None
    elif length == 127:
        try:
            length = struct.unpack('>Q', await reader.readexactly(8))[0]
        except asyncio.IncompleteReadError:
            return None
    if masked:
        try:
            mask = await reader.readexactly(4)
        except asyncio.IncompleteReadError:
            return None
    else:
        mask = None
    try:
        payload = await reader.readexactly(length) if length else b''
    except asyncio.IncompleteReadError:
        return None
    if mask:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return opcode, payload

def ws_make_frame(opcode, payload):
    if isinstance(payload, str):
        payload = payload.encode('utf-8')
    n = len(payload)
    header = bytes([0x80 | opcode])
    if n < 126:
        header += bytes([n])
    elif n < 65536:
        header += bytes([126]) + struct.pack('>H', n)
    else:
        header += bytes([127]) + struct.pack('>Q', n)
    return header + payload

async def ws_send(writer, data):
    if isinstance(data, (dict, list)):
        data = json.dumps(data, separators=(',', ':'))
    try:
        writer.write(ws_make_frame(0x1, data))
        await writer.drain()
        return True
    except Exception:
        return False

# ============================================================
# Estado de jogador
# ============================================================
class ClientState:
    __slots__ = ('id', 'writer', 'name', 'avatar_colors', 'is_adm',
                 'room', 'user_id',
                 'x', 'y', 'z', 'yaw', 'vy', 'hs', 'g', 'last_activity')
    def __init__(self, pid, writer, name,
                 avatar_colors=None, is_adm=False,
                 room='default', user_id=None):
        self.id = pid
        self.writer = writer
        self.name = name
        self.avatar_colors = avatar_colors or {}
        self.is_adm = bool(is_adm)
        self.room = room
        self.user_id = user_id
        self.x = 0.0
        self.y = 3.0
        self.z = 12.0
        self.yaw = 0.0
        self.vy = 0.0
        self.hs = 0.0
        self.g = True
        self.last_activity = time.time()

def _cleanup_client(pid):
    c = clients.pop(pid, None)
    if c and c.user_id and active_users.get(c.user_id) == pid:
        del active_users[c.user_id]

# ============================================================
# Broadcast por sala
# ============================================================
async def broadcast_room(data, room, exclude_id=None):
    if not clients:
        return
    text = json.dumps(data, separators=(',', ':'))
    frame = ws_make_frame(0x1, text)
    dead = []
    for pid, c in list(clients.items()):
        if c.room != room:
            continue
        if pid == exclude_id:
            continue
        try:
            c.writer.write(frame)
            await c.writer.drain()
        except Exception:
            dead.append(pid)
    for pid in dead:
        _cleanup_client(pid)

async def simulation_loop():
    """Envia estados dos jogadores a 20 Hz, por sala."""
    interval = 0.05
    while True:
        await asyncio.sleep(interval)
        if not clients:
            continue
        by_room = {}
        for c in clients.values():
            by_room.setdefault(c.room, []).append(c)
        for room, room_clients in by_room.items():
            states = []
            for c in room_clients:
                states.append({
                    'id': c.id, 'npc': False,
                    'x': round(c.x, 2), 'y': round(c.y, 2), 'z': round(c.z, 2),
                    'yaw': round(c.yaw, 3), 'vy': round(c.vy, 1),
                    'hs': round(c.hs, 2), 'g': c.g
                })
            await broadcast_room({'type': 'states', 'states': states}, room)

# ============================================================
# HTTP estatico
# ============================================================
def guess_content_type(path):
    ext = os.path.splitext(path)[1].lower()
    return {
        '.html': 'text/html; charset=utf-8',
        '.js':   'application/javascript; charset=utf-8',
        '.css':  'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png':  'image/png',
        '.jpg':  'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.svg':  'image/svg+xml',
        '.ico':  'image/x-icon',
    }.get(ext, 'application/octet-stream')

async def send_response(writer, status, body, ctype):
    reason = {200: 'OK', 400: 'Bad Request', 403: 'Forbidden',
              404: 'Not Found', 500: 'Internal Server Error'}.get(status, 'OK')
    headers = (
        f'HTTP/1.1 {status} {reason}\r\n'
        f'Content-Type: {ctype}\r\n'
        f'Content-Length: {len(body)}\r\n'
        f'Cache-Control: no-cache\r\n'
        f'Connection: close\r\n'
        f'\r\n'
    ).encode('utf-8')
    try:
        writer.write(headers + body)
        await writer.drain()
    except Exception:
        pass

async def serve_static(writer, path):
    if path == '/' or path == '':
        path = '/index.html'
    if '?' in path:
        path = path.split('?', 1)[0]
    rel = path.lstrip('/')
    full = os.path.normpath(os.path.join(ROOT, rel))
    if not full.startswith(ROOT):
        await send_response(writer, 403, b'Forbidden', 'text/plain')
        return

    # ---------- Fallback case-insensitive ----------
    if not os.path.isfile(full):
        dir_part = os.path.dirname(full)
        base_part = os.path.basename(full).lower()
        if os.path.isdir(dir_part):
            try:
                for f in os.listdir(dir_part):
                    if f.lower() == base_part:
                        full = os.path.join(dir_part, f)
                        print(f'[serve] case-fix: {rel} -> {os.path.basename(full)}')
                        break
            except OSError:
                pass

    if not os.path.isfile(full):
        print(f'[serve] 404: {rel} (tried {full})')
        await send_response(writer, 404, b'Not Found', 'text/plain')
        return

    try:
        with open(full, 'rb') as f:
            body = f.read()
        print(f'[serve] 200: {rel} ({len(body)} bytes)')
    except OSError as e:
        print(f'[serve] 500: {rel} -> {e}')
        await send_response(writer, 500, b'Error', 'text/plain')
        return

    await send_response(writer, 200, body, guess_content_type(full))

# ============================================================
# HTTP + WS
# ============================================================
async def read_request(reader):
    try:
        line = await asyncio.wait_for(reader.readline(), timeout=15)
    except asyncio.TimeoutError:
        return None
    if not line:
        return None
    parts = line.decode('utf-8', 'replace').strip().split()
    if len(parts) < 3:
        return None
    method, path, version = parts[0], parts[1], parts[2]
    headers = {}
    while True:
        try:
            line = await asyncio.wait_for(reader.readline(), timeout=15)
        except asyncio.TimeoutError:
            return None
        if not line or line in (b'\r\n', b'\n'):
            break
        text = line.decode('utf-8', 'replace').rstrip('\r\n')
        if ':' in text:
            k, v = text.split(':', 1)
            headers[k.strip().lower()] = v.strip()
    return method, path, version, headers

async def handle_client(reader, writer):
    try:
        req = await read_request(reader)
        if req is None:
            return
        method, path, version, headers = req

        upgrade = headers.get('upgrade', '').lower()
        if upgrade == 'websocket' and path.startswith('/ws'):
            await handle_websocket(reader, writer, headers)
            return

        if method in ('GET', 'HEAD'):
            await serve_static(writer, path)
        else:
            await send_response(writer, 404, b'Not Found', 'text/plain')
    except Exception as e:
        print(f'[erro] {e}')
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass

async def handle_websocket(reader, writer, headers):
    global next_player_id
    key = headers.get('sec-websocket-key')
    if not key:
        return

    accept = ws_accept(key)
    response = (
        'HTTP/1.1 101 Switching Protocols\r\n'
        'Upgrade: websocket\r\n'
        'Connection: Upgrade\r\n'
        f'Sec-WebSocket-Accept: {accept}\r\n'
        '\r\n'
    ).encode('utf-8')
    writer.write(response)
    await writer.drain()

    first = await ws_read_frame(reader)
    if not first or first[0] != 0x1:
        return
    try:
        data = json.loads(first[1].decode('utf-8'))
    except Exception:
        return
    if data.get('type') != 'join':
        return

    name = str(data.get('name', 'Player'))[:16].strip() or 'Player'
    avatar_colors = data.get('avatar_colors') or {}
    is_adm = bool(data.get('is_adm'))
    room = str(data.get('game', 'default'))[:64].strip() or 'default'
    user_id = str(data.get('user_id', '')).strip() or None

    # -------- Session lock: um user_id = uma sessao --------
    if user_id:
        old_pid = active_users.get(user_id)
        if old_pid is not None:
            old = clients.get(old_pid)
            # Se a sessao antiga esta viva (atividade < 15s), rejeita a nova
            if old is not None and (time.time() - old.last_activity) < 15:
                await ws_send(writer, {
                    'type': 'error',
                    'code': 'already_playing',
                    'message': 'This account is already playing in another tab or game.'
                })
                try:
                    await writer.drain()
                except Exception:
                    pass
                try:
                    writer.close()
                    await writer.wait_closed()
                except Exception:
                    pass
                print(f'[x] Sessao duplicada rejeitada: {name} ({user_id[:8]})')
                return
            # Sessao antiga morta - remove
            _cleanup_client(old_pid)

    pid = next_player_id
    next_player_id += 1
    client = ClientState(pid, writer, name,
                         avatar_colors, is_adm, room, user_id)
    clients[pid] = client
    if user_id:
        active_users[user_id] = pid

    print(f'[+] {name} (id={pid}, room={room}) entrou. Total: {len(clients)}')

    # Welcome: so os da mesma sala
    existing = []
    for c in clients.values():
        if c.id == pid:
            continue
        if c.room != room:
            continue
        existing.append({
            'id': c.id, 'name': c.name, 'npc': False,
            'x': c.x, 'y': c.y, 'z': c.z, 'yaw': c.yaw,
            'avatar_colors': c.avatar_colors,
            'is_adm': c.is_adm
        })

    await ws_send(writer, {
        'type': 'welcome',
        'id': pid,
        'room': room,
        'players': existing,
        'you': {'name': name, 'is_adm': is_adm}
    })

    # Avisa os outros da mesma sala
    await broadcast_room({
        'type': 'player_join',
        'player': {
            'id': pid, 'name': name, 'npc': False,
            'x': client.x, 'y': client.y, 'z': client.z, 'yaw': client.yaw,
            'avatar_colors': client.avatar_colors,
            'is_adm': client.is_adm
        }
    }, room, exclude_id=pid)

    try:
        while True:
            frame = await ws_read_frame(reader)
            if frame is None:
                break
            opcode, payload = frame
            if opcode == 0x8:
                break
            elif opcode == 0x9:
                writer.write(ws_make_frame(0xA, payload))
                await writer.drain()
                continue
            elif opcode != 0x1:
                continue

            client.last_activity = time.time()

            try:
                msg = json.loads(payload.decode('utf-8'))
            except Exception:
                continue
            mtype = msg.get('type')
            if mtype == 'state':
                try:
                    client.x = float(msg.get('x', 0))
                    client.y = float(msg.get('y', 0))
                    client.z = float(msg.get('z', 0))
                    client.yaw = float(msg.get('yaw', 0))
                    client.vy = float(msg.get('vy', 0))
                    client.hs = float(msg.get('hs', 0))
                    client.g = bool(msg.get('g', True))
                except (TypeError, ValueError):
                    pass
            elif mtype == 'chat':
                text = str(msg.get('text', ''))[:200].strip()
                if text:
                    await broadcast_room({
                        'type': 'chat',
                        'id': pid,
                        'name': client.name,
                        'text': text
                    }, room, exclude_id=pid)
    finally:
        _cleanup_client(pid)
        print(f'[-] {name} (id={pid}) saiu. Total: {len(clients)}')
        await broadcast_room({'type': 'player_leave', 'id': pid}, room)
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass

# ============================================================
# Main
# ============================================================
async def main():
    print(f'\n  ============================================')
    print(f'   HTMLBLOX - servidor rodando (salas por jogo)')
    print(f'  ============================================')
    print(f'   Abra: http://localhost:{PORT}')
    print(f'   Ctrl+C para encerrar.\n')
    asyncio.create_task(simulation_loop())
    server = await asyncio.start_server(handle_client, HOST, PORT)
    async with server:
        await server.serve_forever()

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print('\nEncerrado.')
