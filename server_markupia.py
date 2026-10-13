#!/usr/bin/env python3
"""
Markupia — servidor multiplayer paralelo (FASE 2).

Este arquivo é uma implementação alternativa e paralela ao `server.py`
original. NÃO substitui `server.py`. Pode ser executado em paralelo, em
porta diferente, sem tocar em nenhum arquivo existente.

Compatível 100% com o protocolo do cliente `game.js`:

  Cliente -> Servidor:
    {type:'join',         name, avatar_colors, equipped_items,
                          is_adm, game, user_id}
    {type:'state',        x, y, z, yaw, vy, hs, g, hp, dead}
    {type:'chat',         text}
    {type:'equip_update', equipped_items}

  Servidor -> Cliente:
    {type:'welcome',      id, room, players[], you{name,is_adm}}
    {type:'player_join',  player{...}}
    {type:'player_leave', id}
    {type:'player_equip', id, equipped_items}
    {type:'states',       states[{id,npc,x,y,z,yaw,vy,hs,g,hp,dead}]}
    {type:'chat',         id, name, text}
    {type:'error',        code, message}

Diferenças em relação ao `server.py` original (todas documentadas):

  * hp e dead agora são retransmitidos em `states` (o cliente já os lia,
    mas o servidor os descartava — isso quebrava o sistema de
    morte/respawn de jogadores remotos).
  * `is_adm` enviado pelo cliente é IGNORADO. O servidor sempre publica
    `is_adm: false`. Validação real fica para a FASE 4, com JWT do
    Supabase.
  * `user_id` é aceito apenas para o lock de sessão (como já era).
    Não é tratado como identidade autenticada. FASE 4 substitui por JWT.
  * Validação de tipos em todos os campos (NaN/Infinity rejeitados).
  * Limite de tamanho de frame WebSocket (64 KB).
  * Limite de taxa de mensagens por cliente (40/s em janela rolante).
  * Timeout de inatividade (90 s) e limite total de clientes.
  * Logs com prefixo `[Markupia]` e timestamp.
  * Shutdown limpo via SIGINT/SIGTERM.
  * Frames de cliente sem máscara são rejeitados (RFC 6455).

Uso:

  PORT=8000 python3 server_markupia.py
  # ou
  python3 server_markupia.py

Variáveis de ambiente:

  PORT   (int, padrão 8000)
  HOST   (str, padrão '0.0.0.0')
"""

import asyncio
import base64
import hashlib
import json
import math
import os
import signal
import struct
import sys
import time
from collections import deque

# ============================================================
# CONFIGURAÇÃO
# ============================================================
HOST = os.environ.get('HOST', '0.0.0.0')
PORT = int(os.environ.get('PORT', 8000))
WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
ROOT = os.path.dirname(os.path.abspath(__file__))

MAX_FRAME_SIZE      = 64 * 1024     # 64 KB por frame WebSocket
MAX_MSG_PER_SEC     = 40            # mensagens por segundo por cliente
INACTIVITY_TIMEOUT  = 90.0          # segundos sem atividade -> fecha
MAX_CLIENTS         = 500           # limite global
SESSION_LOCK_WINDOW = 15.0          # mesmo comportamento do server.py
MAX_NAME_LEN        = 16
MAX_ROOM_LEN        = 64
MAX_CHAT_LEN        = 200
MAX_HEADER_BYTES    = 8 * 1024      # limite de cabeçalho HTTP

# ============================================================
# LOG
# ============================================================
def log(*args):
    ts = time.strftime('%H:%M:%S')
    print(f'[Markupia {ts}]', *args, flush=True)

def log_err(*args):
    ts = time.strftime('%H:%M:%S')
    print(f'[Markupia {ts}] [ERRO]', *args, file=sys.stderr, flush=True)

# ============================================================
# ESTADO GLOBAL
# ============================================================
clients = {}            # player_id -> ClientState
next_player_id = 1
active_users = {}       # user_id -> player_id

_shutdown_event = None  # asyncio.Event, criado no main

# ============================================================
# HELPERS — WebSocket RFC 6455
# ============================================================
def ws_accept(key: str) -> str:
    return base64.b64encode(
        hashlib.sha1((key + WS_MAGIC).encode()).digest()
    ).decode()

async def ws_read_frame(reader):
    """
    Lê um frame WebSocket do cliente.
    Retorna (opcode, payload_bytes) ou None se a conexão terminou.
    Frames maiores que MAX_FRAME_SIZE são rejeitados (retorna None).
    """
    try:
        header = await reader.readexactly(2)
    except (asyncio.IncompleteReadError, ConnectionError, OSError):
        return None

    b1, b2 = header[0], header[1]
    fin    = (b1 >> 7) & 1
    opcode = b1 & 0x0F
    masked = (b2 >> 7) & 1
    length = b2 & 0x7F

    # Frames de controle não podem ser fragmentados (RFC 6455 §5.5).
    if opcode >= 0x8 and fin != 1:
        return None

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

    # Guarda contra frames gigantes.
    if length > MAX_FRAME_SIZE:
        log_err(f'frame gigante ({length} bytes) — fechando conexão')
        return None

    # Aplicações clientes DEVEM mascarar. Sem máscara = protocolo inválido.
    if not masked:
        log_err('frame de cliente sem máscara — protocolo inválido')
        return None

    try:
        mask = await reader.readexactly(4)
        payload = await reader.readexactly(length) if length else b''
    except asyncio.IncompleteReadError:
        return None

    payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return opcode, payload

def ws_make_frame(opcode: int, payload) -> bytes:
    """Constrói um frame WebSocket de servidor (não mascarado)."""
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

async def ws_send(writer, data) -> bool:
    """Envia JSON (dict/list) ou string como um frame texto. Retorna True em sucesso."""
    if isinstance(data, (dict, list)):
        try:
            data = json.dumps(data, separators=(',', ':'))
        except (TypeError, ValueError):
            return False
    try:
        writer.write(ws_make_frame(0x1, data))
        await writer.drain()
        return True
    except Exception:
        return False

# ============================================================
# HELPERS — Validação
# ============================================================
def safe_float(v, default=0.0, lo=None, hi=None) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if math.isnan(f) or math.isinf(f):
        return default
    if lo is not None and f < lo:
        return lo
    if hi is not None and f > hi:
        return hi
    return f

def safe_int(v, default=0, lo=None, hi=None) -> int:
    try:
        i = int(v)
    except (TypeError, ValueError):
        return default
    if lo is not None and i < lo:
        return lo
    if hi is not None and i > hi:
        return hi
    return i

def sanitize_avatar_colors(v) -> dict:
    """Aceita apenas chaves/valores dentro de limites conhecidos."""
    if not isinstance(v, dict):
        return {}
    out = {}
    for k, val in v.items():
        if not isinstance(k, str) or len(k) > 32:
            continue
        if isinstance(val, str) and len(val) <= 16:
            out[k] = val
        elif isinstance(val, (int, float)) and not isinstance(val, bool):
            out[k] = safe_int(val, 0, 0, 0xFFFFFF)
    return out

def sanitize_equipped(v) -> dict:
    """
    Formato esperado (vindo do game.js):
      {
        "Head": ["id1", "id2"], "Torso": [...], ..., 
        "face": "id_ou_default_face",
        "shirt": "id|null", "tshirt": "id|null", "pants": "id|null"
      }
    """
    if not isinstance(v, dict):
        return {}
    out = {}
    for k, val in v.items():
        if not isinstance(k, str) or len(k) > 32:
            continue
        if isinstance(val, str):
            out[k] = val[:128]
        elif isinstance(val, list):
            out[k] = [str(x)[:128] for x in val[:16]
                      if isinstance(x, (str, int))]
        elif val is None:
            out[k] = None
        # outros tipos são silenciosamente ignorados
    return out

def sanitize_state(msg: dict) -> dict:
    """Extrai e valida um bloco de estado do jogador."""
    return {
        'x':    safe_float(msg.get('x'),    0.0, -1e6, 1e6),
        'y':    safe_float(msg.get('y'),    0.0, -1e6, 1e6),
        'z':    safe_float(msg.get('z'),    0.0, -1e6, 1e6),
        'yaw':  safe_float(msg.get('yaw'),  0.0, -1e3, 1e3),
        'vy':   safe_float(msg.get('vy'),   0.0, -1e4, 1e4),
        'hs':   safe_float(msg.get('hs'),   0.0,  0.0, 1e4),
        'g':    bool(msg.get('g', True)),
        'hp':   safe_int(msg.get('hp'),   100, 0, 1000),
        'dead': bool(msg.get('dead', False)),
    }

# ============================================================
# CLIENTE
# ============================================================
class ClientState:
    __slots__ = (
        'id', 'writer', 'name', 'avatar_colors', 'equipped_items',
        'is_adm', 'room', 'user_id',
        'x', 'y', 'z', 'yaw', 'vy', 'hs', 'g', 'hp', 'dead',
        'last_activity', 'msg_times',
    )
    def __init__(self, pid, writer, name,
                 avatar_colors=None, equipped_items=None,
                 is_adm=False, room='default', user_id=None):
        self.id = pid
        self.writer = writer
        self.name = name
        self.avatar_colors = avatar_colors or {}
        self.equipped_items = equipped_items or {}
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
        self.hp = 100
        self.dead = False
        self.last_activity = time.time()
        self.msg_times = deque()  # timestamps recentes para rate limit

    def rate_ok(self, now: float) -> bool:
        q = self.msg_times
        while q and now - q[0] > 1.0:
            q.popleft()
        if len(q) >= MAX_MSG_PER_SEC:
            return False
        q.append(now)
        return True

    def to_public_dict(self) -> dict:
        """Forma pública do jogador (usada em welcome/player_join)."""
        return {
            'id': self.id,
            'name': self.name,
            'npc': False,
            'x': round(self.x, 2),
            'y': round(self.y, 2),
            'z': round(self.z, 2),
            'yaw': round(self.yaw, 3),
            'avatar_colors': self.avatar_colors,
            'equipped_items': self.equipped_items,
            'is_adm': self.is_adm,
            'hp': self.hp,
            'dead': self.dead,
        }

def cleanup_client(pid: int) -> ClientState | None:
    c = clients.pop(pid, None)
    if c and c.user_id and active_users.get(c.user_id) == pid:
        del active_users[c.user_id]
    return c

# ============================================================
# BROADCAST
# ============================================================
async def broadcast_room(data, room: str, exclude_id=None):
    """Envia `data` (JSON-serializável) para todos em `room`, exceto exclude_id."""
    if not clients:
        return
    try:
        text = json.dumps(data, separators=(',', ':'))
    except (TypeError, ValueError) as e:
        log_err(f'broadcast serialization failed: {e}')
        return
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
        cleanup_client(pid)

# ============================================================
# LOOP DE SIMULAÇÃO
# ============================================================
async def simulation_loop():
    """
    Broadcast de estados a 20 Hz, por sala.
    Inclui hp e dead (correção em relação ao server.py original).
    """
    interval = 0.05
    while True:
        await asyncio.sleep(interval)
        if not clients:
            continue

        by_room: dict[str, list[ClientState]] = {}
        for c in list(clients.values()):
            by_room.setdefault(c.room, []).append(c)

        for room, room_clients in by_room.items():
            states = []
            for c in room_clients:
                states.append({
                    'id': c.id,
                    'npc': False,
                    'x': round(c.x, 2),
                    'y': round(c.y, 2),
                    'z': round(c.z, 2),
                    'yaw': round(c.yaw, 3),
                    'vy': round(c.vy, 1),
                    'hs': round(c.hs, 2),
                    'g': c.g,
                    'hp': c.hp,
                    'dead': c.dead,
                })
            await broadcast_room({'type': 'states', 'states': states}, room)

# ============================================================
# HTTP ESTÁTICO
# ============================================================
def guess_content_type(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    return {
        '.html':  'text/html; charset=utf-8',
        '.js':    'application/javascript; charset=utf-8',
        '.mjs':   'application/javascript; charset=utf-8',
        '.css':   'text/css; charset=utf-8',
        '.json':  'application/json; charset=utf-8',
        '.png':   'image/png',
        '.jpg':   'image/jpeg',
        '.jpeg':  'image/jpeg',
        '.gif':   'image/gif',
        '.webp':  'image/webp',
        '.svg':   'image/svg+xml',
        '.ico':   'image/x-icon',
        '.woff':  'font/woff',
        '.woff2': 'font/woff2',
        '.ttf':   'font/ttf',
        '.otf':   'font/otf',
        '.mp3':   'audio/mpeg',
        '.ogg':   'audio/ogg',
        '.wav':   'audio/wav',
        '.mp4':   'video/mp4',
        '.webm':  'video/webm',
        '.glb':   'model/gltf-binary',
        '.gltf':  'model/gltf+json',
    }.get(ext, 'application/octet-stream')

async def send_response(writer, status: int, body: bytes, ctype: str):
    reason = {200: 'OK', 400: 'Bad Request', 403: 'Forbidden',
              404: 'Not Found', 413: 'Payload Too Large',
              500: 'Internal Server Error'}.get(status, 'OK')
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

async def serve_static(writer, path: str):
    """Serve arquivo estático com fallback SPA, idêntico ao server.py."""
    if '?' in path:
        path = path.split('?', 1)[0]
    if '#' in path:
        path = path.split('#', 1)[0]
    if path in ('', '/'):
        path = '/index.html'

    rel = path.lstrip('/')
    full = os.path.normpath(os.path.join(ROOT, rel))

    # Proteção contra path traversal.
    if not full.startswith(ROOT + os.sep) and full != ROOT:
        await send_response(writer, 403, b'Forbidden', 'text/plain')
        return

    # Fallback SPA: rotas sem extensão servem index.html.
    if not os.path.isfile(full):
        last_seg = rel.split('/')[-1] if rel else ''
        if last_seg and '.' not in last_seg:
            idx = os.path.join(ROOT, 'index.html')
            if os.path.isfile(idx):
                full = idx

    # Fallback case-insensitive.
    if not os.path.isfile(full):
        dir_part = os.path.dirname(full)
        base_part = os.path.basename(full).lower()
        if os.path.isdir(dir_part):
            try:
                for f in os.listdir(dir_part):
                    if f.lower() == base_part:
                        full = os.path.join(dir_part, f)
                        break
            except OSError:
                pass

    if not os.path.isfile(full):
        # Último fallback SPA.
        last_seg = rel.split('/')[-1] if rel else ''
        if last_seg and '.' not in last_seg:
            idx = os.path.join(ROOT, 'index.html')
            if os.path.isfile(idx):
                full = idx
            else:
                await send_response(writer, 404, b'Not Found', 'text/plain')
                return
        else:
            await send_response(writer, 404, b'Not Found', 'text/plain')
            return

    try:
        with open(full, 'rb') as f:
            body = f.read()
    except OSError as e:
        log_err(f'serve_static: {rel} -> {e}')
        await send_response(writer, 500, b'Error', 'text/plain')
        return

    await send_response(writer, 200, body, guess_content_type(full))

# ============================================================
# PARSER HTTP
# ============================================================
async def read_request(reader):
    """
    Lê a linha de requisição e cabeçalhos HTTP.
    Limita o tamanho total de cabeçalho e usa timeout.
    Retorna (method, path, version, headers) ou None.
    """
    total = 0
    try:
        line = await asyncio.wait_for(reader.readline(), timeout=15)
    except asyncio.TimeoutError:
        return None
    if not line:
        return None
    total += len(line)
    if total > MAX_HEADER_BYTES:
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
        total += len(line)
        if total > MAX_HEADER_BYTES:
            return None
        text = line.decode('utf-8', 'replace').rstrip('\r\n')
        if ':' in text:
            k, v = text.split(':', 1)
            headers[k.strip().lower()] = v.strip()
    return method, path, version, headers

# ============================================================
# HANDLER HTTP/WS
# ============================================================
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
        log_err(f'handle_client: {e!r}')
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass

# ============================================================
# HANDLER WEBSOCKET
# ============================================================
async def handle_websocket(reader, writer, headers):
    global next_player_id

    key = headers.get('sec-websocket-key')
    if not key:
        return

    # Limite global de clientes.
    if len(clients) >= MAX_CLIENTS:
        log_err(f'servidor cheio ({len(clients)}/{MAX_CLIENTS})')
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

    # --- Primeira mensagem: join ---
    first = await ws_read_frame(reader)
    if not first or first[0] != 0x1:
        return
    try:
        data = json.loads(first[1].decode('utf-8'))
    except Exception:
        return
    if not isinstance(data, dict) or data.get('type') != 'join':
        try:
            await ws_send(writer, {
                'type': 'error', 'code': 'malformed',
                'message': 'First message must be a join.'
            })
        except Exception:
            pass
        return

    name = str(data.get('name', 'Player'))[:MAX_NAME_LEN].strip() or 'Player'
    avatar_colors = sanitize_avatar_colors(data.get('avatar_colors'))
    equipped_items = sanitize_equipped(data.get('equipped_items'))
    room = str(data.get('game', 'default'))[:MAX_ROOM_LEN].strip() or 'default'
    raw_user_id = data.get('user_id')
    user_id = None
    if isinstance(raw_user_id, str):
        # Aceita apenas strings plausíveis (UUID ou similar).
        uid = raw_user_id.strip()
        if 0 < len(uid) <= 128:
            user_id = uid

    # is_adm enviado pelo cliente é IGNORADO por segurança.
    # FASE 4 restaura ADM via JWT do Supabase.
    is_adm = False

    # --- Session lock ---
    if user_id:
        old_pid = active_users.get(user_id)
        if old_pid is not None:
            old = clients.get(old_pid)
            if old is not None and (time.time() - old.last_activity) < SESSION_LOCK_WINDOW:
                await ws_send(writer, {
                    'type': 'error',
                    'code': 'already_playing',
                    'message': 'This account is already playing in another tab or game.'
                })
                try:
                    writer.close()
                    await writer.wait_closed()
                except Exception:
                    pass
                log(f'[x] sessão duplicada rejeitada: {name} ({user_id[:8]}…)')
                return
            # Sessão antiga ociosa: remove e avisa a sala antiga.
            if old is not None:
                old_room = old.room
                cleanup_client(old_pid)
                try:
                    await broadcast_room(
                        {'type': 'player_leave', 'id': old_pid}, old_room
                    )
                except Exception:
                    pass

    pid = next_player_id
    next_player_id += 1

    client = ClientState(
        pid, writer, name,
        avatar_colors, equipped_items,
        is_adm, room, user_id
    )
    clients[pid] = client
    if user_id:
        active_users[user_id] = pid

    log(f'[+] {name} (id={pid}, room={room}) entrou. Total: {len(clients)}')

    # --- welcome ---
    existing = []
    for c in clients.values():
        if c.id == pid:
            continue
        if c.room != room:
            continue
        existing.append(c.to_public_dict())

    ok = await ws_send(writer, {
        'type': 'welcome',
        'id': pid,
        'room': room,
        'players': existing,
        'you': {'name': name, 'is_adm': is_adm},
    })
    if not ok:
        cleanup_client(pid)
        return

    # --- player_join para os outros ---
    await broadcast_room({
        'type': 'player_join',
        'player': client.to_public_dict(),
    }, room, exclude_id=pid)

    # --- Loop principal de mensagens ---
    try:
        while True:
            try:
                frame = await asyncio.wait_for(
                    ws_read_frame(reader), timeout=INACTIVITY_TIMEOUT
                )
            except asyncio.TimeoutError:
                log(f'[t] {name} (id={pid}) inativo por {INACTIVITY_TIMEOUT:.0f}s')
                break

            if frame is None:
                break
            opcode, payload = frame

            if opcode == 0x8:      # close
                break
            if opcode == 0x9:      # ping -> pong
                try:
                    writer.write(ws_make_frame(0xA, payload))
                    await writer.drain()
                except Exception:
                    break
                continue
            if opcode != 0x1:      # não texto: ignora
                continue

            now = time.time()
            client.last_activity = now

            if not client.rate_ok(now):
                # Estoura o limite: fecha para não amplificar abuso.
                try:
                    await ws_send(writer, {
                        'type': 'error', 'code': 'rate_limit',
                        'message': 'Too many messages per second.'
                    })
                except Exception:
                    pass
                log_err(f'rate limit atingido por {name} (id={pid})')
                break

            try:
                msg = json.loads(payload.decode('utf-8'))
            except Exception:
                # Ignora silenciosamente — apenas não derruba o processo.
                continue
            if not isinstance(msg, dict):
                continue

            mtype = msg.get('type')

            if mtype == 'state':
                s = sanitize_state(msg)
                client.x = s['x']
                client.y = s['y']
                client.z = s['z']
                client.yaw = s['yaw']
                client.vy = s['vy']
                client.hs = s['hs']
                client.g = s['g']
                client.hp = s['hp']
                client.dead = s['dead']

            elif mtype == 'chat':
                text = str(msg.get('text', ''))[:MAX_CHAT_LEN].strip()
                if text:
                    await broadcast_room({
                        'type': 'chat',
                        'id': pid,
                        'name': client.name,
                        'text': text,
                    }, room, exclude_id=pid)

            elif mtype == 'equip_update':
                client.equipped_items = sanitize_equipped(
                    msg.get('equipped_items')
                )
                await broadcast_room({
                    'type': 'player_equip',
                    'id': pid,
                    'equipped_items': client.equipped_items,
                }, room, exclude_id=pid)

            # Outros tipos são silenciosamente ignorados (compat futura).

    finally:
        cleanup_client(pid)
        log(f'[-] {name} (id={pid}) saiu. Total: {len(clients)}')
        try:
            await broadcast_room({'type': 'player_leave', 'id': pid}, room)
        except Exception:
            pass
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass

# ============================================================
# MAIN
# ============================================================
async def main():
    global _shutdown_event
    _shutdown_event = asyncio.Event()

    print()
    print('  ==================================================')
    print('    MARKUPIA — servidor multiplayer (FASE 2)')
    print('  ==================================================')
    print(f'   Escutando em:  http://{HOST}:{PORT}')
    print(f'   WebSocket em:  ws://{HOST}:{PORT}/ws')
    print(f'   Rotas SPA:     /profile/<id>  /item/<uuid>  ...')
    print(f'   is_adm:        ignorado (FASE 4 substituirá por JWT)')
    print(f'   Ctrl+C para encerrar.')
    print()

    sim_task = asyncio.create_task(simulation_loop())
    server = await asyncio.start_server(handle_client, HOST, PORT)

    # Handlers de sinal — funcionam no Termux para SIGINT e SIGTERM.
    loop = asyncio.get_running_loop()
    def _request_shutdown(signame):
        log(f'recebido {signame}, encerrando…')
        if not _shutdown_event.is_set():
            _shutdown_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _request_shutdown, sig.name)
        except (NotImplementedError, RuntimeError):
            # Fallback se o loop não suportar (raro em Termux).
            signal.signal(sig, lambda s, f: _request_shutdown('signal'))

    try:
        async with server:
            await _shutdown_event.wait()
    finally:
        log('parando servidor…')
        server.close()
        try:
            await server.wait_closed()
        except Exception:
            pass
        sim_task.cancel()
        try:
            await sim_task
        except (asyncio.CancelledError, Exception):
            pass
        # Fecha todas as conexões ativas.
        for pid, c in list(clients.items()):
            try:
                c.writer.close()
            except Exception:
                pass
        clients.clear()
        active_users.clear()
        log('servidor parado.')

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print('\nMarkupia: interrompido pelo usuário.')