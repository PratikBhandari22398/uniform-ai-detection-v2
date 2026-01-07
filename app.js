require("dotenv").config();
const express = require("express");
const path = require("path");
const mongoose = require("mongoose");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const multer = require("multer");
const fs = require("fs");
const tf = require("@tensorflow/tfjs-node");

const app = express();

/* ===================== MODELS ===================== */
const User = require("./models/user");
const Detection = require("./models/detection");

/* ===================== CONFIG ===================== */
const PORT = process.env.PORT || 3000;
const MONGODB_URI =
  process.env.MONGO_URI || "mongodb://localhost:27017/uniformpro";

/* Teacher credentials */
const TEACHER_ID = process.env.TEACHER_ID || "teacher123";
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || "teacher@999";

/* ===================== VIEW ENGINE ===================== */
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");

/* ===================== STATIC ===================== */
app.use(express.static(path.join(__dirname, "public")));

/* ===================== BODY PARSER ===================== */
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "10mb" }));

/* ===================== DATABASE ===================== */
mongoose
  .connect(MONGODB_URI)
  .then(() => console.log("🟢 MongoDB Connected"))
  .catch((err) => console.error("🔴 Mongo Error:", err));

/* ===================== SESSION ===================== */
app.use(
  session({
    secret: process.env.SESSION_SECRET || "uniform-secret",
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: MONGODB_URI }),
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 },
  })
);

/* ===================== GLOBAL USER ===================== */
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.isTeacher = req.session.isTeacher || false;
  next();
});

/* ===================== AUTH HELPERS ===================== */
function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}

function requireTeacher(req, res, next) {
  if (!req.session.isTeacher) return res.redirect("/teacher-login");
  next();
}

/* ===================== ROUTES ===================== */

/* ---------- HOME ---------- */
app.get("/", (req, res) => res.render("home"));

/* ---------- SIGNUP ---------- */
app.get("/signup", (req, res) => {
  if (req.session.user) return res.redirect("/detect");
  res.render("users/signup");
});

app.post("/signup", async (req, res) => {
  const { username, email, password, department, year, division } = req.body;

  try {
    const user = await User.create({
      username,
      email,
      password,
      department,
      year,
      division,
      role: "student",
    });

    req.session.user = user;
    res.redirect("/detect");
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).render("users/signup", {
      error: "Username or email already exists",
    });
  }
});

/* ---------- LOGIN ---------- */
app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/detect");
  res.render("users/login");
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    const user = await User.findOne({ username, password });
    if (!user) {
      return res
        .status(400)
        .render("users/login", { error: "Invalid username or password" });
    }

    req.session.user = user;
    res.redirect("/detect");
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).send("Server error");
  }
});

/* ---------- LOGOUT ---------- */
app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

/* ---------- DETECT PAGE ---------- */
app.get("/detect", requireLogin, async (req, res) => {
  const history = await Detection.find({ user: req.session.user._id })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  res.render("detect", { history });
});

/* ===================== TEACHER ===================== */

app.get("/teacher-login", (req, res) =>
  res.render("users/teacher-login")
);

app.post("/teacher-login", (req, res) => {
  const { teacherId, password } = req.body;

  if (teacherId === TEACHER_ID && password === TEACHER_PASSWORD) {
    req.session.isTeacher = true;
    return res.redirect("/teacher/students");
  }

  res.render("users/teacher-login", {
    error: "Invalid teacher credentials",
  });
});

app.post("/teacher-logout", (req, res) => {
  req.session.isTeacher = false;
  res.redirect("/");
});

/* ---------- TEACHER DASHBOARD ---------- */
app.get("/teacher/students", requireTeacher, async (req, res) => {
  const { department, year, division, date } = req.query;

  // 1. Filter Students
  const studentFilter = { role: "student" };
  if (department) studentFilter.department = department;
  if (year) studentFilter.year = year;
  if (division) studentFilter.division = division;

  const students = await User.find(studentFilter).lean();

  // 2. Filter Detections (Date Logic)
  const pipeline = [];

  // Match Date if provided
  if (date) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);

    pipeline.push({
      $match: {
        createdAt: { $gte: start, $lte: end }
      }
    });
  }

  // Group by User to get latest status
  pipeline.push(
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: "$user",
        lastLabel: { $first: "$label" },
        lastIsCompliant: { $first: "$isCompliant" },
        lastAt: { $first: "$createdAt" },
      },
    }
  );

  const detections = await Detection.aggregate(pipeline);

  // 3. Map Detections to Students
  const uniformMap = {};
  detections.forEach((d) => {
    uniformMap[d._id.toString()] = d;
  });

  // Render view with query object to fix ReferenceError
  res.render("users/teacher-students", {
    students,
    uniformMap,
    query: req.query 
  });
});

/* ---------- CSV EXPORT ---------- */
app.get("/teacher/students/export", requireTeacher, async (req, res) => {
  const { department, year, division, date } = req.query;

  // 1. Get filtered students
  const studentFilter = { role: "student" };
  if (department) studentFilter.department = department;
  if (year) studentFilter.year = year;
  if (division) studentFilter.division = division;
  const students = await User.find(studentFilter).lean();

  // 2. Get filtered detections
  const detFilter = {};
  if (date) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);
    detFilter.createdAt = { $gte: start, $lte: end };
  }
  const detections = await Detection.find(detFilter).sort({ createdAt: -1 }).lean();

  // 3. Map latest detection to user
  const map = {};
  detections.forEach((d) => {
    if (!map[d.user]) map[d.user] = d;
  });

  let csv = "Username,Email,Department,Year,Division,Label,Uniform Status,Date\n";

  students.forEach((s) => {
    const d = map[s._id];
    const status = d ? (d.isCompliant ? "OK" : "NOT OK") : "No Data";
    const label = d ? d.label : "";
    const dateStr = d ? new Date(d.createdAt).toLocaleString() : "";
    
    csv += `"${s.username}","${s.email}","${s.department}","${s.year}","${s.division}","${label}","${status}","${dateStr}"\n`;
  });

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    "attachment; filename=students_uniform_report.csv"
  );

  res.send(csv);
});

/* ===================== IMAGE UPLOAD ===================== */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "public/uploads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) =>
    cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

/* ===================== ML MODEL ===================== */
let model = null;

(async () => {
  try {
    const modelPath =
  "file://" + path.join(__dirname, "tfjs_model/model.json");
    model = await tf.loadLayersModel(modelPath);
    console.log("✅ AI Model Loaded");
  } catch (err) {
    console.error("❌ Model Load Error:", err.message);
  }
})();

/* ===================== DETECTION LOGIC HELPER ===================== */
async function handleDetection(req, res) {
    if (!model) return res.status(500).json({ error: "Model not ready" });
    if (!req.file) return res.status(400).json({ error: "No image received" });

    try {
        const buffer = fs.readFileSync(req.file.path);

        const tensor = tf.node
          .decodeImage(buffer, 3)
          .resizeNearestNeighbor([224, 224])
          .expandDims()
          .toFloat()
          .div(255);

        const preds = model.predict(tensor);
        const scores = Array.from(preds.dataSync());

        const LABELS = [
          "1st year",
          "2nd year",
          "3rd year",
          "without uniform and id",
        ];

        const maxScore = Math.max(...scores);
        const maxIndex = scores.indexOf(maxScore);
        const predictedLabel = LABELS[maxIndex];

        const CONFIDENCE_THRESHOLD = 0.75;

        let finalLabel = "uncertain";
        let isCompliant = false;

        if (maxScore >= CONFIDENCE_THRESHOLD) {
          finalLabel = predictedLabel;
          // Logic: Compliant if NOT "without uniform..."
          if (predictedLabel !== "without uniform and id") {
            isCompliant = true;
          }
        }

        // Save detection history
        await Detection.create({
          user: req.session.user._id,
          username: req.session.user.username,
          label: finalLabel,
          confidence: maxScore,
          isCompliant,
          source: req.path.includes('frame') ? "webcam" : "upload",
        });

        // Cleanup resources
        tf.dispose([tensor, preds]);
        try { fs.unlinkSync(req.file.path); } catch(e){}

        res.json({
          label: finalLabel,
          confidence: maxScore,
          uniformStatus: isCompliant ? "Uniform OK" : "Not in Uniform",
        });
    } catch (err) {
        console.error("Detection Error:", err);
        res.status(500).json({ error: "Processing failed" });
    }
}

/* ===================== DETECTION ROUTES ===================== */
// Route 1: For File Uploads / Snapshots
app.post("/detect-image", requireLogin, upload.single("image"), handleDetection);

// Route 2: For Live Camera Frames (Fixes the server error)
app.post("/detect-frame", requireLogin, upload.single("image"), handleDetection);

/* ===================== 404 ===================== */
app.use((req, res) => res.status(404).send("404 Not Found"));

/* ===================== START ===================== */
app.listen(PORT, () =>
  console.log(`🚀 Server running at http://localhost:${PORT}`)
);