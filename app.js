const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const fetch = require("node-fetch");
const crypto = require("crypto");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

const firebase_url = process.env.firebase_url;

// Secure RNG
function secureRandomInt(max) {
  return crypto.randomInt(0, max);
}

// Convert JS Date → Firestore timestamp
function toFirestoreTimestamp(date) {
  return date.toISOString().replace("Z", "") + "Z";
}

// -----------------------------------------------------------
// QUERY FIRESTORE (Structured Query) — For 2000ClubPayment
// -----------------------------------------------------------
async function queryFirestoreStructured(collection, filters, firebaseToken) {
  const url = `${firebase_url}:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: collection }],
      where: filters && filters.length
        ? { compositeFilter: { op: "AND", filters } }
        : undefined,
      orderBy: [
        { field: { fieldPath: "dateSubmitted" }, direction: "ASCENDING" },
      ],
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${firebaseToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!Array.isArray(data)) {
    console.error("Unexpected Firestore structured query response:", data);
    return [];
  }

  return data
    .filter((d) => d.document)
    .map((d) => {
      const doc = d.document;
      return {
        id: doc.name.split("/").pop(),
        ...Object.fromEntries(
          Object.entries(doc.fields || {}).map(([k, v]) => [
            k,
            Object.values(v)[0],
          ])
        ),
      };
    });
}

// -----------------------------------------------------------
// FETCH USERS COLLECTION (Paginated GET) — For User Lookup
// -----------------------------------------------------------
async function fetchAllUsers(firebaseToken) {
  let url = `${firebase_url}/users`;
  let users = [];

  while (url) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${firebaseToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.error("Failed to fetch users:", response.statusText);
      break;
    }

    const data = await response.json();

    if (data.documents && Array.isArray(data.documents)) {
      const batch = data.documents.map((doc) => ({
        id: doc.name.split("/").pop(),
        ...Object.fromEntries(
          Object.entries(doc.fields || {}).map(([k, v]) => [
            k,
            Object.values(v)[0],
          ])
        ),
      }));
      users.push(...batch);
    }

    // Pagination support
    if (data.nextPageToken) {
      url = `${firebase_url}/users?pageToken=${data.nextPageToken}`;
    } else {
      url = null;
    }
  }

  console.log(`Fetched ${users.length} users total`);
  return users;
}

// -----------------------------------------------------------
// DRAW ENDPOINT
// -----------------------------------------------------------
app.post("/draw", async (req, res) => {
  const firebaseToken = req.body?.firebaseToken;
  const month = req.body?.month ?? 0;
  const year = req.body?.year ?? 0;

  if (!firebaseToken) {
    return res.status(401).json({
      message:
        "Missing Firebase token. Provide in request body as firebaseToken.",
    });
  }

  const winnersPerClub = 5;

  try {
    // Timestamp boundaries for filtering
    const startIso = toFirestoreTimestamp(
      new Date(Date.UTC(year, month - 1, 1, 0, 0, 0))
    );
    const endIso = toFirestoreTimestamp(
      new Date(Date.UTC(year, month, 1, 0, 0, 0))
    );

    //step 0 - prevent draw until month is over 
    const nowUtc = new Date();
    if (nowUtc.getTime() < new Date(endIso).getTime()) {
      return res.status(400).json({
        message: `Draw not allowed: month ${month}/${year} is not complete. Draws allowed after ${endIso}.`,
      });
    }

    // Step 1: Query confirmed payments for that month
    const filters = [
      {
        fieldFilter: {
          field: { fieldPath: "dateSubmitted" },
          op: "GREATER_THAN_OR_EQUAL",
          value: { timestampValue: startIso },
        },
      },
      {
        fieldFilter: {
          field: { fieldPath: "dateSubmitted" },
          op: "LESS_THAN",
          value: { timestampValue: endIso },
        },
      },
      {
        fieldFilter: {
          field: { fieldPath: "donationConfirmed" },
          op: "EQUAL",
          value: { booleanValue: true },
        },
      },
    ];

    const entries = await queryFirestoreStructured(
      "2000ClubPayment",
      filters,
      firebaseToken
    );

    console.log(
      `Found ${entries.length} confirmed payments for ${month}/${year}`
    );

    if (entries.length === 0) {
      return res.json({
        message: "No confirmed payments found for the specified month and year.",
      });
    }

    // Step 2: Filter valid entries
    const requiredFields = ["clubName", "hhNumber", "reference"];
    const validPayments = entries.filter((e) =>
      requiredFields.every(
        (f) => e[f] !== undefined && e[f] !== null && String(e[f]).trim() !== ""
      )
    );

    console.log(
      `Valid payments: ${validPayments.length}, removed ${
        entries.length - validPayments.length
      } invalid`
    );

    // Step 3: Group by club
    const grouped = {};
    for (const entry of validPayments) {
      if (!grouped[entry.clubName]) grouped[entry.clubName] = [];
      grouped[entry.clubName].push(entry);
    }

    console.log(`Grouped into ${Object.keys(grouped).length} clubs`);

    // Step 4: Load all users once
    const users = await fetchAllUsers(firebaseToken);

    // Step 5: Randomly pick winners per club
    const allWinners = [];
    for (const clubName of Object.keys(grouped)) {
      const clubEntries = [...grouped[clubName]];
      const winners = [];

      while (winners.length < winnersPerClub && clubEntries.length > 0) {
        const index = secureRandomInt(clubEntries.length);
        const winner = clubEntries.splice(index, 1)[0];
        const user = users.find((u) => u.regNumber === winner.hhNumber) || null;

        winners.push({
          clubName,
          regNumber: winner.hhNumber,
          ticketRef: winner.reference,
          donorName: winner.donorName,
          donorEmail: winner.donorEmail,
          user,
          drawnAt: new Date().toISOString(),
        });
      }

      console.log(`Selected ${winners.length} winners for ${clubName}`);
      allWinners.push(...winners);
    }

    // Step 6: Assign positions per club
    const winnersByClub = {};
    for (const winner of allWinners) {
      if (!winnersByClub[winner.clubName]) {
        winnersByClub[winner.clubName] = [];
      }
      winnersByClub[winner.clubName].push(winner);
    }

    for (const [clubName, clubWinners] of Object.entries(winnersByClub)) {
      // Sort by drawnAt (optional)
      clubWinners.sort((a, b) => new Date(a.drawnAt) - new Date(b.drawnAt));

      // Assign position (1st, 2nd, 3rd, ...)
      clubWinners.forEach((winner, index) => {
        const pos = index + 1;
        winner.position =
          pos === 1
            ? "1st"
            : pos === 2
            ? "2nd"
            : pos === 3
            ? "3rd"
            : `${pos}th`;
      });
    }

    // Flatten again
    const rankedWinners = Object.values(winnersByClub).flat();

    // Step 7: Build final response
    const clubs = Object.keys(grouped).map((clubName) => ({
      clubName,
      entries: grouped[clubName].length,
    }));

    const totalPayments = validPayments.length;

    const response = {
      month,
      year,
      totalPayments,
      clubs,
      totalWinners: rankedWinners.length,
      winners: rankedWinners,
    };

    res.json(response);
  } catch (error) {
    console.error("Error during draw:", error);
    res.status(500).json({
      message: "An error occurred during the draw process.",
      error: error.message,
    });
  }
});

module.exports = app;
