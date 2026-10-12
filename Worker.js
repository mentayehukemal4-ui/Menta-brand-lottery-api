const BIN_ID = "6ac7b364ac6210605a1fea6e";

const DEFAULT_DB = {
  lottery: {
    name: "MENTA BRAND የዕድል ሙከራ",
    status: "open",
    ticketPrice: 0,
    currency: "ETB",
    prize: {
      name: "",
      description: "",
      image: ""
    },
    drawDate: null
  },
  tickets: [],
  winners: [],
  transactions: []
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers
      });
    }

    try {
      if (!env.JSONBIN_MASTER_KEY) {
        return json({
          ok: false,
          error: "JSONBIN_MASTER_KEY is missing"
        }, 500, headers);
      }

      if (!env.TELEGRAM_BOT_TOKEN) {
        return json({
          ok: false,
          error: "TELEGRAM_BOT_TOKEN is missing"
        }, 500, headers);
      }

      const db = await readDB(env);

      // 1. API STATUS
      if (path === "/" && request.method === "GET") {
        return json({
          ok: true,
          service: "Menta Brand Lottery API"
        }, 200, headers);
      }

      // 2. PUBLIC LOTTERY INFORMATION
      if (
        path === "/api/lottery" &&
        request.method === "GET"
      ) {
        return json({
          ok: true,
          lottery: db.lottery,
          ticketsSold: db.tickets.filter(
            t => t.status === "confirmed"
          ).length,
          winners: db.winners
        }, 200, headers);
      }

      // 3. GET TICKET HISTORY
      if (
        path === "/api/lottery/my-tickets" &&
        request.method === "GET"
      ) {
        const user = await telegramUser(request, env);

        if (!user) {
          return json({
            ok: false,
            error: "Telegram authentication failed"
          }, 401, headers);
        }

        return json({
          ok: true,
          tickets: db.tickets.filter(
            t => t.userId === String(user.id)
          )
        }, 200, headers);
      }

      // 4. RESERVE LOTTERY TICKETS
      if (
        path === "/api/lottery/tickets" &&
        request.method === "POST"
      ) {
        const user = await telegramUser(request, env);

        if (!user) {
          return json({
            ok: false,
            error: "Telegram authentication failed"
          }, 401, headers);
        }

        if (db.lottery.status !== "open") {
          return json({
            ok: false,
            error: "Lottery is not open"
          }, 409, headers);
        }

        const body = await request.json();
        const quantity = Number(body.quantity);

        if (
          !Number.isInteger(quantity) ||
          quantity < 1 ||
          quantity > 10
        ) {
          return json({
            ok: false,
            error: "Quantity must be between 1 and 10"
          }, 400, headers);
        }

        if (
          !Number.isFinite(db.lottery.ticketPrice) ||
          db.lottery.ticketPrice <= 0
        ) {
          return json({
            ok: false,
            error: "Ticket price has not been configured"
          }, 409, headers);
        }

        const existing = db.tickets.filter(
          t => t.userId === String(user.id) &&
               t.status === "pending"
        );

        if (existing.length + quantity > 10) {
          return json({
            ok: false,
            error: "Too many pending tickets"
          }, 409, headers);
        }

        const created = [];

        for (let i = 0; i < quantity; i++) {
          const ticket = {
            id: crypto.randomUUID(),
            number: crypto.randomUUID()
              .replace(/-/g, "")
              .slice(0, 10)
              .toUpperCase(),
            userId: String(user.id),
            username: user.username || "",
            price: db.lottery.ticketPrice,
            status: "pending",
            createdAt: new Date().toISOString()
          };

          db.tickets.push(ticket);
          created.push(ticket);
        }

        await writeDB(env, db);

        return json({
          ok: true,
          message: "Tickets reserved; payment not verified",
          tickets: created,
          total: quantity * db.lottery.ticketPrice,
          currency: db.lottery.currency
        }, 201, headers);
      }

      // 5. PUBLIC DRAW RESULTS
      if (
        path === "/api/lottery/results" &&
        request.method === "GET"
      ) {
        return json({
          ok: true,
          winners: db.winners
        }, 200, headers);
      }

      // ADMIN ROUTES REQUIRE TELEGRAM ADMIN ID
      if (path.startsWith("/api/admin/")) {
        const user = await telegramUser(request, env);

        if (!user || !isAdmin(user.id, env)) {
          return json({
            ok: false,
            error: "Admin access denied"
          }, 403, headers);
        }

        // 6. UPDATE LOTTERY AND PRIZE
        if (
          path === "/api/admin/lottery" &&
          request.method === "POST"
        ) {
          const body = await request.json();

          if (body.ticketPrice !== undefined) {
            const price = Number(body.ticketPrice);

            if (!Number.isFinite(price) || price <= 0) {
              return json({
                ok: false,
                error: "Invalid ticket price"
              }, 400, headers);
            }

            db.lottery.ticketPrice = price;
          }

          if (body.name !== undefined) {
            db.lottery.name = String(body.name).slice(0, 120);
          }

          if (body.status !== undefined) {
            if (!["open", "closed"].includes(body.status)) {
              return json({
                ok: false,
                error: "Invalid lottery status"
              }, 400, headers);
            }

            db.lottery.status = body.status;
          }

          if (body.prize !== undefined) {
            if (
              !body.prize ||
              typeof body.prize !== "object"
            ) {
              return json({
                ok: false,
                error: "Invalid prize"
              }, 400, headers);
            }

            db.lottery.prize = {
              name: String(body.prize.name || "").slice(0, 120),
              description: String(
                body.prize.description || ""
              ).slice(0, 1000),
              image: String(body.prize.image || "").slice(0, 2000)
            };
          }

          await writeDB(env, db);

          return json({
            ok: true,
            lottery: db.lottery
          }, 200, headers);
        }

        // 7. CONFIRM PAYMENT
        if (
          path === "/api/admin/confirm-ticket" &&
          request.method === "POST"
        ) {
          const body = await request.json();

          const ticket = db.tickets.find(
            t => t.id === body.ticketId
          );

          if (!ticket) {
            return json({
              ok: false,
              error: "Ticket not found"
            }, 404, headers);
          }

          if (ticket.status !== "pending") {
            return json({
              ok: false,
              error: "Ticket is not pending"
            }, 409, headers);
          }

          ticket.status = "confirmed";
          ticket.confirmedAt = new Date().toISOString();

          await writeDB(env, db);

          return json({
            ok: true,
            ticket
          }, 200, headers);
        }

        // 8. DRAW A WINNER
        if (
          path === "/api/admin/draw" &&
          request.method === "POST"
        ) {
          if (db.lottery.status !== "closed") {
            return json({
              ok: false,
              error: "Close the lottery before drawing"
            }, 409, headers);
          }

          const eligible = db.tickets.filter(
            t => t.status === "confirmed"
          );

          if (!eligible.length) {
            return json({
              ok: false,
              error: "No confirmed tickets available"
            }, 409, headers);
          }

          if (
            db.winners.some(
              w => w.lotteryName === db.lottery.name
            )
          ) {
            return json({
              ok: false,
              error: "A winner has already been recorded for this lottery"
            }, 409, headers);
          }

          const random = new Uint32Array(1);
          const limit = Math.floor(
            4294967296 / eligible.length
          ) * eligible.length;

          let value;

          do {
            crypto.getRandomValues(random);
            value = random[0];
          } while (value >= limit);

          const winnerTicket = eligible[
            value % eligible.length
          ];

          const winner = {
            id: crypto.randomUUID(),
            lotteryName: db.lottery.name,
            ticketId: winnerTicket.id,
            ticketNumber: winnerTicket.number,
            userId: winnerTicket.userId,
            prize: db.lottery.prize,
            drawnAt: new Date().toISOString()
          };

          db.winners.push(winner);
          db.lottery.drawDate = winner.drawnAt;

          await writeDB(env, db);

          return json({
            ok: true,
            winner
          }, 200, headers);
        }
      }

      return json({
        ok: false,
        error: "Endpoint not found"
      }, 404, headers);

    } catch (error) {
      return json({
        ok: false,
        error: "Internal server error"
      }, 500, headers);
    }
  }
};

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers
  });
}

async function readDB(env) {
  const response = await fetch(
    `https://api.jsonbin.io/v3/b/${BIN_ID}/latest`,
    {
      headers: {
        "X-Master-Key": env.JSONBIN_MASTER_KEY
      }
    }
  );

  if (!response.ok) {
    throw new Error("Database read failed");
  }

  const result = await response.json();

  return {
    ...DEFAULT_DB,
    ...(result.record || {}),
    lottery: {
      ...DEFAULT_DB.lottery,
      ...(result.record?.lottery || {})
    },
    tickets: result.record?.tickets || [],
    winners: result.record?.winners || [],
    transactions: result.record?.transactions || []
  };
}

async function writeDB(env, db) {
  const response = await fetch(
    `https://api.jsonbin.io/v3/b/${BIN_ID}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Master-Key": env.JSONBIN_MASTER_KEY
      },
      body: JSON.stringify(db)
    }
  );

  if (!response.ok) {
    throw new Error("Database write failed");
  }
}

async function telegramUser(request, env) {
  const initData = request.headers.get("X-Telegram-Init-Data");

  if (!initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");

  if (!hash) return null;

  params.delete("hash");

  const entries = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b));

  const dataCheckString = entries
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const encoder = new TextEncoder();

  const secretKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const secret = await crypto.subtle.sign(
    "HMAC",
    secretKey,
    encoder.encode(env.TELEGRAM_BOT_TOKEN)
  );

  const verificationKey = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const calculatedHash = await crypto.subtle.sign(
    "HMAC",
    verificationKey,
    encoder.encode(dataCheckString)
  );

  const calculatedHex = [...new Uint8Array(calculatedHash)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  if (!constantTimeEqual(calculatedHex, hash)) {
    return null;
  }

  const authDate = Number(params.get("auth_date"));

  if (
    !Number.isFinite(authDate) ||
    Math.abs(Date.now() / 1000 - authDate) > 300
  ) {
    return null;
  }

  try {
    return JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;

  let result = 0;

  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

function isAdmin(userId, env) {
  const ids = (env.ADMIN_TELEGRAM_IDS || "")
