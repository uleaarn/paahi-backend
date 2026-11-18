# Adding and configuring a business

Each business is one folder under `businesses/`. The folder name is the business ID.

```text
businesses/
  jalwa-montclair/
    business.json   profile, locations, numbers, languages, workflows, escalation, notifications
    menu.json       data for the restaurant_ordering workflow
```

The server loads every folder at startup and **refuses to start** if any config is invalid: an unknown language or workflow, a phone number used twice, a menu outside the folder, and so on. Problems show up at deploy time, not during a call.

## business.json

```jsonc
{
  "id": "harbor-cafe",                 // must match the folder name
  "name": "Harbor Cafe",
  "short_name": "Harbor",              // used when speaking
  "business_type": "restaurant",
  "timezone": "America/New_York",
  "agent_name": "Paahi",
  "locations": [
    { "id": "main", "name": "Harbor Cafe", "address": "…", "phone": "…",
      "hours": { "monday": "11:00 AM - 9:00 PM", "sunday": "Closed", "…": "…" } }
  ],
  "phone_numbers": [ "+12015550199" ],  // Twilio numbers that ring this business
                                        // or { "number": "+1…", "location_id": "main" }
  "languages": {
    "default": "en",
    "enabled": ["en"],                  // see docs/LANGUAGES.md
    "allow_experimental": false,        // required to enable es / fr / hi / te
    "greetings": { "en": "Thanks for calling Harbor Cafe! How can I help?" },  // optional
    "voices": { "en": { "voice": "en-US-Neural2-F" } }                          // optional
  },
  "faqs": [ { "q": "Do you have parking?", "a": "Yes, free parking behind the building." } ],
  "workflows": {
    "restaurant_ordering": { "enabled": true, "menu_file": "menu.json", "order_types": ["pickup"] }
  },
  "escalation": { "callback_enabled": true, "transfer_phone_env": null },
  "notifications": { "email_to_env": "HARBOR_EMAIL_TO", "webhook_url_env": null }
}
```

- **Secrets and contact details** are never written in this file. A field ending in `_env` holds the **name** of an environment variable. For example, `"email_to_env": "HARBOR_EMAIL_TO"` means you set `HARBOR_EMAIL_TO=orders@harbor.example` on the server.
- **Only implemented workflows can be enabled.** Today that is just `restaurant_ordering`. Appointments, general inquiries and other workflows need their own module in `workflows/`, written to the interface described at the top of `workflows/restaurant-ordering.js`.
- **Delivery** stays off until `order_types` includes `"delivery"` **and** a `delivery` rules block exists. The server rejects delivery without rules. The rules (area, fee, minimum) aren't designed yet.
- **FAQs** are the only free-form facts the agent may state. Leave the list empty rather than guess.

## Routing

1. Twilio calls `POST /twiml` with `To` (the number dialed).
2. That number is looked up in every business's `phone_numbers`. One number belongs to exactly one business.
3. If nothing matches and `DEFAULT_BUSINESS_ID` is set, the call goes to that business. Otherwise the caller hears "this number is not set up" and the call ends.
4. The business ID travels to the media stream as a stream parameter. A stream naming an unknown business is closed.

## Isolation

- A call session receives only its own business object: menu, hours, FAQs, languages and notification settings. The model prompt contains only that business's data (covered by a test).
- Each business has its own order submitter: its own email recipient, its own webhook, and its own records folder `logs/<business-id>/`.
- In the database, every row carries `business_id`, and Postgres row-level security only exposes the business set for the current transaction (see `docs/DATABASE.md`).
- `/analytics/*` requires `ADMIN_API_TOKEN` and can filter by `?business_id=`. It's an operator view, not a business-owner view.

## Notifications

A confirmed order is saved in the database first. It is placed once saved. Then the business's email (and webhook, if set) is notified from an outbox, with retries. A business that takes orders must have at least one working channel, or the server won't start.

## n8n

Paahi doesn't use n8n. Calls, orders and staff alerts run entirely in this backend. A business can still name an optional webhook (`webhook_url_env`) if some other system should receive orders; Jalwa doesn't.
