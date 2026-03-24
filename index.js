const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const supabase = require("./supabase");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(cors());
app.use(express.json());

setInterval(async () => {
  try {
    const now = new Date();
    const limit = new Date(now.getTime() - 15000);

    const { data, error } = await supabase
      .from("devices")
      .select("id, last_seen");

    if (error) return;

    for (const device of data) {
      if (!device.last_seen) continue;

      const lastSeen = new Date(device.last_seen);

      if (lastSeen < limit) {
        await supabase
          .from("devices")
          .update({ status: "offline" })
          .eq("id", device.id);
      }
    }

  } catch (err) {
    console.error("Offline checker error:", err.message);
  }
}, 10000);

app.post("/heartbeat", async (req, res) => {
  const { rustdesk_id } = req.body;

  const { data } = await supabase
    .from("devices")
    .select("*")
    .eq("rustdesk_id", rustdesk_id)
    .maybeSingle();

  if (!data || data.pending_delete) {
    if (data?.pending_delete) {
      await supabase
        .from("devices")
        .delete()
        .eq("rustdesk_id", rustdesk_id);

      io.emit("devices:update");
    }

    return res.json({ active: false });
  }

  await supabase
    .from("devices")
    .update({ last_seen: new Date(), status: "online" })
    .eq("rustdesk_id", rustdesk_id);

  res.json({ active: true });
});


const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) return res.sendStatus(401);

  const token = authHeader.split(" ")[1];

  if (!token) return res.sendStatus(401);

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    return res.sendStatus(403);
  }

  req.user = data.user;
  next();
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
        status: "online"
      }
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
  const { data, error } = await supabase.from("devices").select("*");

  if (error) return res.status(500).json(error);

  const now = Date.now();

  const devices = data.map(d => {
    if (!d.last_seen) {
      return { ...d, status: "offline" };
    }

    const diff = now - new Date(d.last_seen).getTime();

    return {
      ...d,
      status: diff < 15000 ? "online" : "offline"
    };
  });

  res.json(devices);
});


app.delete("/devices/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from("devices")
      .update({ pending_delete: true })
      .eq("id", id);

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
  console.log(`Servidor en puerto ${PORT}`);
});