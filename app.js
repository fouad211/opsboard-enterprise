require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const redis = require("redis");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");
const helmet = require("helmet");
const morgan = require("morgan");

const app = express();

const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGO_URL;
const REDIS_URL = process.env.REDIS_URL;
const JWT_SECRET = process.env.JWT_SECRET;

let redisClient;
let totalRequests = 0;
let totalErrors = 0;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(morgan("combined"));

app.use((req, res, next) => {
  totalRequests++;
  next();
});

const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  role: { type: String, default: "engineer" },
  createdAt: { type: Date, default: Date.now }
});

const projectSchema = new mongoose.Schema({
  name: String,
  description: String,
  environment: { type: String, default: "development" },
  status: { type: String, default: "active" },
  createdAt: { type: Date, default: Date.now }
});

const taskSchema = new mongoose.Schema({
  title: String,
  description: String,
  priority: { type: String, default: "medium" },
  status: { type: String, default: "todo" },
  createdAt: { type: Date, default: Date.now }
});

const incidentSchema = new mongoose.Schema({
  title: String,
  service: String,
  severity: { type: String, default: "medium" },
  status: { type: String, default: "open" },
  details: String,
  createdAt: { type: Date, default: Date.now }
});

const deploymentSchema = new mongoose.Schema({
  appName: String,
  version: String,
  environment: { type: String, default: "staging" },
  status: { type: String, default: "success" },
  createdAt: { type: Date, default: Date.now }
});

const auditLogSchema = new mongoose.Schema({
  user: String,
  action: String,
  resource: String,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", userSchema);
const Project = mongoose.model("Project", projectSchema);
const Task = mongoose.model("Task", taskSchema);
const Incident = mongoose.model("Incident", incidentSchema);
const Deployment = mongoose.model("Deployment", deploymentSchema);
const AuditLog = mongoose.model("AuditLog", auditLogSchema);

function auth(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    req.user = jwt.verify(header.split(" ")[1], JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
}

async function audit(user, action, resource) {
  try {
    await AuditLog.create({
      user: user?.email || "system",
      action,
      resource
    });
  } catch {}
}

async function clearCache() {
  const keys = await redisClient.keys("*");
  if (keys.length) await redisClient.del(keys);
}

app.get("/health", async (req, res) => {
  let redisStatus = "disconnected";

  try {
    await redisClient.ping();
    redisStatus = "connected";
  } catch {}

  res.json({
    status: "OK",
    app: "OpsBoard Enterprise",
    mongodb: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    redis: redisStatus,
    uptime: Math.floor(process.uptime())
  });
});

app.get("/metrics", async (req, res) => {
  const users = await User.countDocuments();
  const projects = await Project.countDocuments();
  const tasks = await Task.countDocuments();
  const incidents = await Incident.countDocuments();
  const deployments = await Deployment.countDocuments();

  res.json({
    app: "OpsBoard Enterprise",
    totalRequests,
    totalErrors,
    uptimeSeconds: Math.floor(process.uptime()),
    stats: {
      users,
      projects,
      tasks,
      incidents,
      deployments
    }
  });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    const exists = await User.findOne({ email });
    if (exists) return res.status(409).json({ message: "Email already exists" });

    const usersCount = await User.countDocuments();

    const user = await User.create({
      name,
      email,
      password: await bcrypt.hash(password, 10),
      role: usersCount === 0 ? "admin" : "engineer"
    });

    await audit(user, "REGISTER", "User");

    res.status(201).json({
      message: "Registered successfully",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    totalErrors++;
    res.status(500).json({ message: "Register failed", error: err.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ message: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    const token = jwt.sign(
      { id: user._id, name: user.name, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: "1d" }
    );

    await audit(user, "LOGIN", "Auth");

    res.json({
      message: "Login successful",
      token,
      user: {
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    totalErrors++;
    res.status(500).json({ message: "Login failed", error: err.message });
  }
});

app.get("/api/dashboard", auth, async (req, res) => {
  const cache = await redisClient.get("dashboard");
  if (cache) return res.json({ source: "redis-cache", data: JSON.parse(cache) });

  const data = {
    projects: await Project.countDocuments(),
    tasks: await Task.countDocuments(),
    todoTasks: await Task.countDocuments({ status: "todo" }),
    doneTasks: await Task.countDocuments({ status: "done" }),
    incidents: await Incident.countDocuments(),
    openIncidents: await Incident.countDocuments({ status: "open" }),
    deployments: await Deployment.countDocuments()
  };

  await redisClient.setEx("dashboard", 30, JSON.stringify(data));

  res.json({ source: "mongodb", data });
});

app.get("/api/projects", auth, async (req, res) => {
  const data = await Project.find().sort({ createdAt: -1 });
  res.json(data);
});

app.post("/api/projects", auth, async (req, res) => {
  const item = await Project.create(req.body);
  await clearCache();
  await audit(req.user, "CREATE", "Project");
  res.status(201).json(item);
});

app.get("/api/tasks", auth, async (req, res) => {
  const data = await Task.find().sort({ createdAt: -1 });
  res.json(data);
});

app.post("/api/tasks", auth, async (req, res) => {
  const item = await Task.create(req.body);
  await clearCache();
  await audit(req.user, "CREATE", "Task");
  res.status(201).json(item);
});

app.patch("/api/tasks/:id", auth, async (req, res) => {
  const item = await Task.findByIdAndUpdate(req.params.id, req.body, { new: true });
  await clearCache();
  res.json(item);
});

app.delete("/api/tasks/:id", auth, async (req, res) => {
  await Task.findByIdAndDelete(req.params.id);
  await clearCache();
  res.json({ message: "Task deleted" });
});

app.get("/api/incidents", auth, async (req, res) => {
  const data = await Incident.find().sort({ createdAt: -1 });
  res.json(data);
});

app.post("/api/incidents", auth, async (req, res) => {
  const item = await Incident.create(req.body);
  await clearCache();
  await audit(req.user, "CREATE", "Incident");
  res.status(201).json(item);
});

app.patch("/api/incidents/:id", auth, async (req, res) => {
  const item = await Incident.findByIdAndUpdate(req.params.id, req.body, { new: true });
  await clearCache();
  res.json(item);
});

app.get("/api/deployments", auth, async (req, res) => {
  const data = await Deployment.find().sort({ createdAt: -1 });
  res.json(data);
});

app.post("/api/deployments", auth, async (req, res) => {
  const item = await Deployment.create(req.body);
  await clearCache();
  await audit(req.user, "CREATE", "Deployment");
  res.status(201).json(item);
});

app.get("/api/audit-logs", auth, async (req, res) => {
  const logs = await AuditLog.find().sort({ createdAt: -1 }).limit(50);
  res.json(logs);
});

async function start() {
  try {
    await mongoose.connect(MONGO_URL);
    console.log("MongoDB connected");

    redisClient = redis.createClient({ url: REDIS_URL });
    await redisClient.connect();
    console.log("Redis connected");

    app.listen(PORT, () => {
      console.log(`OpsBoard Enterprise running on port ${PORT}`);
    });
  } catch (err) {
    console.error("Startup error:", err);
    process.exit(1);
  }
}

start();
