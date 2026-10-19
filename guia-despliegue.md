# 🚀 Guía: publica tu juego UNO con dirección fija (GRATIS)

**Tiempo:** ~15 minutos · **Costo:** $0 · **Tarjeta de crédito:** NO se necesita
**Resultado:** una dirección fija tipo `https://tu-juego.onrender.com` para compartir donde quieras.

> Todo se hace desde el navegador. Puede ser en la computadora o en el teléfono
> (en el teléfono, activa "Sitio de escritorio" en el menú del navegador).

Vas a crear 2 cuentas gratuitas:
1. **GitHub** — para guardar los archivos del juego (como Google Drive para programadores).
2. **Render** — para que el juego viva en internet con tu dirección fija.

---

## PASO 1 — Crear cuenta en GitHub (3 min)

1. Entra a **https://github.com**
2. Haz clic en **Sign up** (Registrarse).
3. Escribe tu correo, crea una contraseña y elige un nombre de usuario.
4. Verifica tu correo con el código que te llegue.
5. ¡Listo! Si te hacen una encuesta de preferencias, puedes saltarla.

## PASO 2 — Subir el juego a GitHub (5 min)

1. Dentro de GitHub, busca el botón verde **New** (o entra a **https://github.com/new**).
2. En *Repository name* escribe: `uno-multijugador`
3. Deja marcado **Public** (importante: Render necesita que sea público en su plan gratis).
4. Haz clic en **Create repository**.
5. Verás una página que dice *"Quick setup"*. Busca el enlace pequeño que dice
   **"uploading an existing file"** y haz clic ahí.
6. **Extrae el archivo `uno-deploy.zip`** en tu computadora (clic derecho → Extraer todo).
7. **Arrastra los archivos extraídos** al área de GitHub que dice *"Drag files here"*.
   > Deben entrar: la carpeta `public`, `server.js`, `package.json` y `render.yaml`.
8. Abajo, escribe un mensaje cualquiera (ej. `juego`) y haz clic en
   **Commit changes** (botón verde).

¡Ya tienes el juego guardado en GitHub!

## PASO 3 — Crear cuenta en Render (2 min)

1. Entra a **https://render.com**
2. Haz clic en **Get Started for Free** y elige **Continue with GitHub**
   (así no necesitas crear otra contraseña).
3. Autoriza a Render cuando te lo pida.

## PASO 4 — ¡Publicar! (4 min)

1. En el panel de Render, haz clic en **New +** → **Web Service**.
2. Busca el repositorio **`uno-multijugador`** y haz clic en **Connect**.
3. Rellena así:
   - **Name:** `tu-uno` (o el nombre que quieras — esto será tu dirección:
     `https://tu-uno.onrender.com`)
   - **Runtime:** Node
   - **Region:** déjala como está
   - **Instance Type:** elige **Free** ($0)
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
4. Haz clic en **Create Web Service** (abajo).
5. Espera 2-3 minutos mientras se instala (verás un log con texto verde y azul).
6. Cuando termine, arriba verás tu dirección: **https://tu-uno.onrender.com** 🎉

## PASO 5 — ¡Jugar!

1. Abre tu dirección en el navegador — debe cargar el menú del juego.
2. Compártela por WhatsApp con tus amigos.
3. Cualquiera crea una sala y los demás se unen con el código.

---

## ⚠️ Cosas importantes que debes saber

- **La primera vez que alguien entra después de un rato**, la página puede tardar
  ~1 minuto en despertar (Render "duerme" el juego para ahorrar recursos).
  Diles a tus amigos: *"si se queda cargando, esperen un minuto y recarguen"*.
- **Mientras haya jugadores conectados, NO se duerme** — solo duerme después de
  15 minutos sin visitas.
- Si un día Render te pide verificar el correo, verifícalo — sigue siendo gratis.
- **Plan B siempre disponible:** si algo falla, el juego funciona igual en tu casa
  con `iniciar-servidor-publico.bat` o en un solo teléfono con `uno-local.html`.

## 🔄 Actualizar el juego en el futuro

Si modificas archivos: ve a tu repositorio en GitHub → **Add file** → **Upload files**
→ arrastra los archivos nuevos → **Commit changes**. Render se actualiza solo.

---

¿Problemas? Casi siempre es:
- *"No encuentra el repositorio"* → revisa que sea **Public** (Paso 2.3).
- *"No empieza"* → revisa que el **Start Command** sea exactamente `node server.js`.
- *"Se queda cargando"* → espera 1 minuto (despertando) y recarga.
