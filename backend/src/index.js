import cors from "cors";
import express from "express";
import http from "http";
import { commentaryRouter } from "./routes/commentary.js";
import { matchRouter } from "./routes/matches.js";
import { attachWebSocketServer } from "./ws/server.js";

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || "0.0.0.0";

const app = express();
const server = http.createServer(app);
app.use(express.json());
app.use(cors());

app.get("/", (req, res) => {
  res.send("Hello from Express server!");
});
app.use("/matches", matchRouter);
app.use("/matches/:id/commentary", commentaryRouter);

const {
  broadcastMatchCreated,
  broadcastScoreUpdate,
  broadcastCommentaryCreated,
  close: closeWebSocketServer,
} = attachWebSocketServer(server);

app.locals.broadcastMatchCreated = broadcastMatchCreated;
app.locals.broadcastScoreUpdate = broadcastScoreUpdate;
app.locals.broadcastCommentaryCreated = broadcastCommentaryCreated;

server.listen(PORT, () => {
  const baseUrl =
    HOST === "0.0.0.0" ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;

  console.log(`Server is running on ${baseUrl}`);
  console.log(
    `WebSocket Server is running on ${baseUrl.replace("http", "ws")}/ws`,
  );
});

function shutdown(signal) {
  console.log(JSON.stringify({ level: "info", message: "shutdown_started", signal }));
  closeWebSocketServer();
  server.close(() => {
    console.log(JSON.stringify({ level: "info", message: "shutdown_complete" }));
    process.exit(0);
  });

  setTimeout(() => {
    console.error(
      JSON.stringify({ level: "error", message: "shutdown_forced", signal }),
    );
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
