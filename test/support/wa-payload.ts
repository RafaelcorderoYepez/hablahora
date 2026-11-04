/** Payload mínimo de un webhook de la WhatsApp Cloud API. */
export function waPayload(opts: { phoneNumberId: string; from: string; id: string; text?: string; type?: string; name?: string }) {
  const type = opts.type ?? "text";
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001111", phone_number_id: opts.phoneNumberId },
              contacts: [{ wa_id: opts.from, profile: { name: opts.name ?? "Rafa" } }],
              messages: [
                {
                  from: opts.from,
                  id: opts.id,
                  timestamp: "1791810000",
                  type,
                  ...(type === "text" ? { text: { body: opts.text } } : {}),
                  ...(type === "audio" ? { audio: { id: "media-1", mime_type: "audio/ogg" } } : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}
