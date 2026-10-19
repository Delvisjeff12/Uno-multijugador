# 🃏 UNO Multijugador

El clásico juego de cartas UNO para **2 a 6 jugadores**, con dos modos de juego:

- **🎮 Local (mismo dispositivo)**: los jugadores se turnan y pasan la pantalla. No necesita internet.
- **🌐 En línea (código de sala)**: cada jugador entra desde su propio dispositivo con un código de 5 letras.

Con reglas clásicas: cartas de acción, Comodines, acumulación de **+2 / +4**, la regla de gritar **¡UNO!** y puntuación por rondas.

![Menú](preview-menu.png)

## ▶️ Cómo ejecutar

```bash
node server.js
```

Luego abre **http://localhost:3000** en el navegador. (También funciona con `npm start`.)

No necesita dependencias: solo Node.js 18 o superior.

### 📱 Jugar desde el teléfono

**Opción A — En tu casa (mismo WiFi), sin internet:**
1. Ejecuta `node server.js` en tu computadora.
2. Averigua la IP de tu computadora en la red local:
   - **Windows**: `ipconfig` → "Dirección IPv4"
   - **Mac/Linux**: `ifconfig` o `ip addr`
3. En el teléfono (conectado al **mismo WiFi**), abre `http://LA-IP:3000`.
4. Un jugador crea la sala y los demás se unen con el código — puedes mezclar teléfono y computadora en la misma partida.

**Opción B — Compartir el juego con otros teléfonos (desde cualquier lugar):**

Ejecuta **`iniciar-servidor-publico.bat`** (Windows) o **`iniciar-servidor-publico.sh`** (Mac/Linux) con un doble clic. El juego se publica en internet y en la consola verás una línea que dice:

```
Visit it at: https://xxxxxxxx.trycloudflare.com
```

Esa dirección es la que compartes (WhatsApp, correo…) y cualquiera entra desde su teléfono. Ten en cuenta que **la dirección cambia cada vez que ejecutas el archivo**.

**Opción C — Dirección permanente (para siempre):**

Despliega el juego en un hosting gratuito que ejecute Node.js (Render, Railway, Fly.io, Replit…):
- Solo necesita ejecutar `node server.js` y respetar la variable de entorno `PORT` (ya está soportada).
- Así tendrás una dirección fija tipo `https://tu-juego.onrender.com` que nunca se cae.

**Opción D — Solo un teléfono (sin conexión):**

Abre el archivo **`uno-local.html`** en el navegador del teléfono (enviátelo por WhatsApp/correo y ábrelo). Juegan 2 a 6 personas pasándose el dispositivo, sin internet.

## 🕹️ Cómo jugar

### Modo local
1. **Jugar en local** → elige cuántos jugadores y sus nombres.
2. Toca **¡Repartir cartas!** y pasa el dispositivo cuando te toque (la pantalla se oculta para que nadie vea tus cartas).
3. Al quedarte con una carta, pulsa **¡UNO!** antes de que se acabe la cuenta.

### Modo en línea
1. Un jugador elige **Crear sala en línea** y comparte el código (ej. `K7Q2M`).
2. Los demás eligen **Unirse con código**, escriben el código y su nombre.
3. El anfitrión pulsa **Iniciar partida**. Cada quien juega desde su dispositivo en tiempo real.

![Mesa de juego](preview-mesa.png)

## 📖 Reglas aplicadas (clásicas)

| Carta | Efecto |
|-------|--------|
| Número | Debe coincidir color o número con la mesa |
| Prohibido (⊘) | El siguiente pierde su turno |
| Reversa (⇄) | Invierte el sentido (con 2 jugadores funciona como Prohibido) |
| +2 | El siguiente roba 2 y pierde su turno |
| Comodín (★) | Eliges el nuevo color |
| Comodín +4 | Eliges color y el siguiente roba 4 |

- **Acumulación**: si te cae un +2 o +4, puedes responder con otro +2 o +4 y pasar la suma al siguiente. Si no, robas toda la suma acumulada.
- **¡UNO!**: al quedarte con una carta debes pulsar ¡UNO! en 7 segundos. Si no, cualquiera puede atraparte (o vence el tiempo) y robas 2 cartas.
- **Robar**: robas 1 carta y, si es jugable, puedes lanzarla de inmediato; si no, pasas el turno.
- **Puntuación**: números = su valor; Prohibido/Reversa/+2 = 20; Comodines = 50. Gana la ronda quien se queda sin cartas y suma los puntos de las cartas ajenas.

![Multijugador en línea](preview-online-beto.png)

## 🗂️ Estructura del proyecto

```
uno-game/
├── server.js          # Servidor web + salas en línea (REST + SSE)
├── public/
│   ├── game.js        # Motor del juego (compartido: navegador y servidor)
│   ├── index.html     # Interfaz
│   ├── style.css      # Estilo clásico colorido
│   └── app.js         # Lógica de cliente (local y en línea)
├── test-engine.js     # Pruebas del motor (node test-engine.js)
└── package.json
```

## ⚙️ Detalles técnicos

- **Sin dependencias**: servidor con el módulo `http` de Node y eventos en tiempo real con **Server-Sent Events**.
- **Servidor autoritativo** en modo en línea: cada jugador solo ve su propia mano (las cartas ajenas nunca se envían al navegador).
- **Reconexión automática**: si recargas la página, la sesión de la sala se restaura.
- **Modo local** reutiliza el mismo motor de reglas en el navegador.

## 🧪 Pruebas

```bash
node test-engine.js
```

Verifica el mazo de 108 cartas, reglas de coincidencia, acumulación +2/+4, ventana de UNO, atrapar sin UNO, conservación de cartas y la finalización de 30 partidas simuladas.
