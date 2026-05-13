import express from "express";
import { createServer as createViteServer } from "vite";
import { PrismaClient } from "@prisma/client";
import * as xlsx from "xlsx";
import path from "path";

const prisma = new PrismaClient();
const app = express();
const PORT = 3000;

// Check DB connection
prisma.$connect()
  .then(() => console.log("Connected to SQLite database"))
  .catch((err) => {
    console.error("Failed to connect to database. Falling back to local mode for API requests.");
    console.error(err.message);
  });

app.use(express.json({ limit: '50mb' }));

// API Routes
app.get("/api/conferences", async (req, res) => {
  try {
    const conferences = await prisma.conference.findMany({
      orderBy: { createdAt: 'desc' }
    });
    res.json(conferences);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch conferences" });
  }
});

app.post("/api/conferences", async (req, res) => {
  const { name, date, location, address } = req.body;
  try {
    const conference = await prisma.conference.create({
      data: { 
        name, 
        date: date ? new Date(date) : null, 
        location, 
        address 
      }
    });
    res.json(conference);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to create conference" });
  }
});

app.get("/api/exhibitors", async (req, res) => {
  const { conferenceId } = req.query;
  if (!conferenceId) return res.status(400).json({ error: "conferenceId required" });
  
  try {
    const exhibitors = await prisma.exhibitor.findMany({
      where: { conferenceId: String(conferenceId) },
      orderBy: { companyName: 'asc' }
    });
    res.json(exhibitors);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch exhibitors" });
  }
});

app.patch("/api/exhibitors/:id", async (req, res) => {
  const { id } = req.params;
  const data = req.body;
  try {
    const exhibitor = await prisma.exhibitor.update({
      where: { id },
      data
    });
    res.json(exhibitor);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update exhibitor" });
  }
});

app.post("/api/exhibitors/import", async (req, res) => {
  const { conferenceId, data } = req.body; // data is base64 or array of objects
  if (!conferenceId || !data) return res.status(400).json({ error: "Missing data" });

  try {
    const conference = await prisma.conference.findUnique({
      where: { id: String(conferenceId) }
    });

    if (!conference) {
      return res.status(404).json({ error: "Conference not found in database." });
    }

    // Expecting data to be an array of objects from the frontend parser
    const exhibitors = await prisma.$transaction(
      data.map((item: any) => prisma.exhibitor.create({
        data: {
          companyName: item.companyName || "Unknown",
          boothNumber: String(item.boothNumber || ""),
          industry: item.industry || "",
          estimatedRevenue: String(item.estimatedRevenue || ""),
          employeeCount: String(item.employeeCount || ""),
          notes: item.notes || "",
          conferenceId
        }
      }))
    );
    res.json({ count: exhibitors.length });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to import exhibitors" });
  }
});

app.get("/api/contacts", async (req, res) => {
  const { conferenceId } = req.query;
  if (!conferenceId) return res.status(400).json({ error: "conferenceId required" });
  
  try {
    const contacts = await prisma.contact.findMany({
      where: { conferenceId: String(conferenceId) },
      orderBy: { createdAt: 'desc' }
    });
    res.json(contacts);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch contacts" });
  }
});

app.post("/api/contacts", async (req, res) => {
  const { name, title, company, phoneNumber, emailAddress, conferenceId } = req.body;
  if (!name || !conferenceId) return res.status(400).json({ error: "name and conferenceId required" });
  
  try {
    // Check if conference exists to avoid foreign key constraint error
    const conference = await prisma.conference.findUnique({
      where: { id: String(conferenceId) }
    });

    if (!conference) {
      return res.status(404).json({ error: "Conference not found in database. Please ensure the event is initialized." });
    }

    const contact = await prisma.contact.create({
      data: {
        name,
        title,
        company,
        phoneNumber,
        emailAddress,
        conferenceId
      }
    });
    res.json(contact);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to create contact" });
  }
});

app.patch("/api/contacts/:id", async (req, res) => {
  const { id } = req.params;
  const data = req.body;
  try {
    const contact = await prisma.contact.update({
      where: { id },
      data
    });
    res.json(contact);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update contact" });
  }
});

// Vite middleware for development
if (process.env.NODE_ENV !== "production") {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else {
  app.use(express.static(path.join(process.cwd(), "dist")));
  app.get("*", (req, res) => {
    res.sendFile(path.join(process.cwd(), "dist", "index.html"));
  });
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
