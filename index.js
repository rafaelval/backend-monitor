require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const supabase = require("./supabase");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

app.use(cors());
app.use(express.json());

app.get("/server-status", (req, res) => {
  res.json({ status: "online" });
});

app.post("/heartbeat", async (req, res) => {
  try {
    const { rustdesk_id } = req.body;

    if (!rustdesk_id) return res.sendStatus(400);

    const { data, error } = await supabase
      .from("devices")
      .select("*")
      .eq("rustdesk_id", rustdesk_id)
      .maybeSingle();

    if (error) {
      console.error("Heartbeat error:", error.message);
      return res.sendStatus(500);
    }

    await supabase
      .from("devices")
      .update({
        last_seen: new Date(),
        status: "online",
      })
      .eq("rustdesk_id", rustdesk_id);

    res.json({ active: true });
  } catch (err) {
    console.error("Heartbeat crash:", err.message);
    res.sendStatus(500);
  }
});

const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.sendStatus(401);

    const token = authHeader.split(" ")[1];
    if (!token) return res.sendStatus(401);

    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) return res.sendStatus(403);

    req.user = data.user;
    next();
  } catch (err) {
    res.sendStatus(500);
  }
};

app.post("/register-device", async (req, res) => {
  try {
    const { name, rustdesk_id } = req.body;

    if (!rustdesk_id) {
      return res.status(400).json({ error: "rustdesk_id requerido" });
    }

    const { data: existing } = await supabase
      .from("devices")
      .select("*")
      .eq("rustdesk_id", rustdesk_id)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("devices")
        .update({ name, password: req.body.password })
        .eq("rustdesk_id", rustdesk_id);

      io.emit("devices:update");
      return res.json({ message: "Dispositivo actualizado" });
    }

    const { error } = await supabase.from("devices").insert([
      {
        name,
        rustdesk_id,
        password: req.body.password,
        status: "online",
        last_seen: new Date(),
      },
    ]);

    if (error) {
      console.error(error);
      return res.status(500).json(error);
    }

    io.emit("devices:update");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Error registrando dispositivo" });
  }
});

app.get("/devices", authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from("devices").select("*");

    if (error) return res.status(500).json(error);

    const now = Date.now();

    const devices = data.map((d) => {
      if (!d.last_seen) {
        return { ...d, status: "offline" };
      }

      const diff = now - new Date(d.last_seen).getTime();

      return {
        ...d,
        status: diff < 15000 ? "online" : "offline",
      };
    });

    res.json(devices);
  } catch (err) {
    res.status(500).json({ error: "Error obteniendo dispositivos" });
  }
});

app.delete("/devices/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase.from("devices").delete().eq("id", id);

    if (error) return res.status(500).json(error);

    io.emit("devices:update");

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Error eliminando dispositivo" });
  }
});

app.put("/devices/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    const { error } = await supabase
      .from("devices")
      .update({ name })
      .eq("id", id);

    if (error) return res.status(500).json(error);

    io.emit("devices:update");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Error actualizando dispositivo" });
  }
});

io.on("connection", (socket) => {
  console.log("Cliente conectado");

  const sendDevices = async () => {
    const { data } = await supabase.from("devices").select("*");
    socket.emit("devices:update", data);
  };

  sendDevices();

  socket.on("refresh", sendDevices);

  socket.on("disconnect", () => {
    console.log("Cliente desconectado");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor en http://localhost:${PORT}`);
});
