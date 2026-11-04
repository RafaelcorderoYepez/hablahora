import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { agendaEn, agendaEs } from "./i18n-agenda.js";
import { inboxEn, inboxEs } from "./i18n-inbox.js";
import { metricsEn, metricsEs } from "./i18n-metrics.js";
import { platformEn, platformEs } from "./i18n-platform.js";
import { configEn, configEs } from "./i18n-config.js";

export type Locale = "es" | "en";
export type Role = "owner" | "admin" | "member";

const es = {
  common: {
    loading: "Cargando…",
    loadError: "No pudimos cargar esto. Revisa tu conexión.",
    retry: "Reintentar",
    cancel: "Cancelar",
    menu: "Menú",
    genericError: "No se pudo completar. Intenta de nuevo.",
  },
  nav: {
    home: "Inicio",
    agenda: "Agenda",
    bookings: "Reservas",
    conversations: "Conversaciones",
    metrics: "Métricas",
    business: "Negocio",
    services: "Servicios",
    staff: "Equipo",
    hours: "Horario",
    policies: "Políticas",
    agent: "Agente",
    webChat: "Chat web",
    users: "Usuarios",
  },
  roles: { owner: "Dueño", admin: "Administrador", member: "Staff" } as Record<Role, string>,
  menu: { language: "Idioma", logout: "Cerrar sesión", switchBusiness: "Cambiar de negocio" },
  login: {
    title: "Ingresa a tu negocio",
    email: "Correo",
    password: "Contraseña",
    submit: "Ingresar",
    forgot: "¿Olvidaste tu contraseña?",
    invalid: "Correo o contraseña incorrectos.",
    emailInvalid: "Escribe un correo válido.",
    passwordRequired: "Escribe tu contraseña.",
  },
  forgot: {
    title: "Recupera tu contraseña",
    body: "Te mandamos un enlace para elegir una contraseña nueva.",
    submit: "Enviar enlace",
    sent: "Si hay una cuenta con ese correo, te llegó un enlace. Revisa tu bandeja de entrada.",
    back: "Volver a ingresar",
  },
  reset: {
    title: "Elige tu contraseña",
    password: "Contraseña nueva",
    confirm: "Repite la contraseña",
    submit: "Guardar contraseña",
    done: "Listo. Ya puedes ingresar con tu contraseña.",
    invalidLink: "El enlace venció o ya se usó. Pide uno nuevo.",
    requestNew: "Pedir un enlace nuevo",
    mismatch: "Las contraseñas no coinciden.",
    minLength: "Usa al menos 10 caracteres.",
  },
  invitation: {
    title: (org: string) => `Te invitaron a ${org}`,
    asRole: (role: string) => `Vas a entrar como ${role.toLowerCase()}.`,
    createAccount: "Crear mi cuenta",
    haveAccount: "Ya tengo cuenta",
    name: "Tu nombre",
    nameRequired: "Escribe tu nombre.",
    accept: "Aceptar invitación",
    acceptAs: (email: string) => `Ingresaste como ${email}.`,
    expired: "Esta invitación venció. Pide al negocio que te invite de nuevo.",
    used: "Esta invitación ya no está disponible.",
    notFound: "No encontramos esta invitación. Revisa el enlace del correo.",
    wrongAccount: (email: string) => `Esta invitación es para ${email}. Cierra sesión e ingresa con esa cuenta.`,
    accepted: (org: string) => `Bienvenido a ${org}.`,
  },
  choose: {
    title: "Elige un negocio",
    none: "Tu cuenta todavía no pertenece a ningún negocio.",
  },
  home: {
    greeting: (name: string) => `Hola, ${name.split(" ")[0]}`,
    ready: "Tu chat está listo para atender",
    notReady: "Falta configurar tu negocio",
    readyBody: "Tienes lo mínimo para recibir reservas. Puedes seguir ajustando la configuración cuando quieras.",
    notReadyBody: "Completa estos pasos para que tu chat pueda atender a tus clientes.",
    checks: {
      services: "Al menos un servicio activo con un profesional",
      hours: "El horario del local",
      web_chat_slug: "El enlace de tu chat",
      agent_knowledge: "Lo que el agente debe saber",
    } as Record<string, string>,
    recommended: "Recomendado",
    done: "Listo",
    pending: "Pendiente",
    configure: "Configurar",
  },
  users: {
    title: "Usuarios",
    subtitle: "Quién puede entrar a la consola de tu negocio.",
    members: "Miembros",
    you: "Tú",
    role: "Rol",
    inviteTitle: "Invitar a alguien",
    inviteBody: "Le llega un correo para crear su cuenta.",
    inviteEmail: "Correo",
    inviteRole: "Rol",
    inviteSubmit: "Enviar invitación",
    invited: (email: string) => `Invitación enviada a ${email}.`,
    pending: "Invitaciones pendientes",
    expires: (date: string) => `Vence el ${date}`,
    resend: "Reenviar",
    resent: "Invitación reenviada.",
    cancelInvite: "Cancelar",
    cancelled: "Invitación cancelada.",
    remove: "Quitar acceso",
    removeTitle: (name: string) => `¿Quitar el acceso de ${name}?`,
    removeBody: (business: string) => `Ya no podrá entrar a la consola de ${business}. Puedes invitarle de nuevo cuando quieras.`,
    removed: "Acceso quitado.",
    roleChanged: "Rol actualizado.",
    readOnly: "Solo los administradores pueden invitar, cambiar roles o quitar accesos.",
    roleHelp: "Administrador configura el negocio. Staff ve la agenda y atiende conversaciones.",
    errors: {
      LAST_ADMIN: "El negocio necesita al menos un administrador.",
      YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER: "El negocio necesita a su dueño.",
      USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION: "Esa persona ya es parte del negocio.",
      USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION: "Esa persona ya tiene una invitación pendiente. Usa Reenviar.",
      INVALID_ROLE: "Invita como administrador o staff.",
      BUSINESS_SUSPENDED: "Tu negocio está suspendido: no se pueden cambiar usuarios.",
      BUSINESS_CLOSED: "Este negocio fue dado de baja.",
    } as Record<string, string>,
  },
  staffNote: "Tu rol es staff: puedes ver la configuración, pero no cambiarla.",
  cfg: configEs,
  agenda: agendaEs,
  inbox: inboxEs,
  metrics: metricsEs,
  platform: platformEs,
};

export type Messages = typeof es;

const en: Messages = {
  common: {
    loading: "Loading…",
    loadError: "We couldn't load this. Check your connection.",
    retry: "Try again",
    cancel: "Cancel",
    menu: "Menu",
    genericError: "That didn't work. Please try again.",
  },
  nav: {
    home: "Home",
    agenda: "Schedule",
    bookings: "Bookings",
    conversations: "Conversations",
    metrics: "Insights",
    business: "Business",
    services: "Services",
    staff: "Team",
    hours: "Hours",
    policies: "Policies",
    agent: "Assistant",
    webChat: "Web chat",
    users: "Users",
  },
  roles: { owner: "Owner", admin: "Admin", member: "Staff" },
  menu: { language: "Language", logout: "Sign out", switchBusiness: "Switch business" },
  login: {
    title: "Sign in to your business",
    email: "Email",
    password: "Password",
    submit: "Sign in",
    forgot: "Forgot your password?",
    invalid: "Wrong email or password.",
    emailInvalid: "Enter a valid email.",
    passwordRequired: "Enter your password.",
  },
  forgot: {
    title: "Reset your password",
    body: "We'll send you a link to choose a new password.",
    submit: "Send link",
    sent: "If there's an account with that email, a link is on its way. Check your inbox.",
    back: "Back to sign in",
  },
  reset: {
    title: "Choose your password",
    password: "New password",
    confirm: "Repeat the password",
    submit: "Save password",
    done: "Done. You can now sign in with your password.",
    invalidLink: "This link expired or was already used. Ask for a new one.",
    requestNew: "Get a new link",
    mismatch: "The passwords don't match.",
    minLength: "Use at least 10 characters.",
  },
  invitation: {
    title: (org: string) => `You're invited to ${org}`,
    asRole: (role: string) => `You'll join as ${role.toLowerCase()}.`,
    createAccount: "Create my account",
    haveAccount: "I have an account",
    name: "Your name",
    nameRequired: "Enter your name.",
    accept: "Accept invitation",
    acceptAs: (email: string) => `Signed in as ${email}.`,
    expired: "This invitation expired. Ask the business to invite you again.",
    used: "This invitation is no longer available.",
    notFound: "We couldn't find this invitation. Check the link in the email.",
    wrongAccount: (email: string) => `This invitation is for ${email}. Sign out and sign in with that account.`,
    accepted: (org: string) => `Welcome to ${org}.`,
  },
  choose: {
    title: "Choose a business",
    none: "Your account doesn't belong to any business yet.",
  },
  home: {
    greeting: (name: string) => `Hi, ${name.split(" ")[0]}`,
    ready: "Your chat is ready to take bookings",
    notReady: "Your business still needs setup",
    readyBody: "You have the minimum to take bookings. You can keep adjusting the setup anytime.",
    notReadyBody: "Complete these steps so your chat can serve your customers.",
    checks: {
      services: "At least one active service with a team member",
      hours: "Your business hours",
      web_chat_slug: "Your chat link",
      agent_knowledge: "What the assistant should know",
    },
    recommended: "Recommended",
    done: "Done",
    pending: "To do",
    configure: "Set up",
  },
  users: {
    title: "Users",
    subtitle: "Who can sign in to your business console.",
    members: "Members",
    you: "You",
    role: "Role",
    inviteTitle: "Invite someone",
    inviteBody: "They'll get an email to create their account.",
    inviteEmail: "Email",
    inviteRole: "Role",
    inviteSubmit: "Send invitation",
    invited: (email: string) => `Invitation sent to ${email}.`,
    pending: "Pending invitations",
    expires: (date: string) => `Expires ${date}`,
    resend: "Resend",
    resent: "Invitation resent.",
    cancelInvite: "Cancel",
    cancelled: "Invitation cancelled.",
    remove: "Remove access",
    removeTitle: (name: string) => `Remove ${name}'s access?`,
    removeBody: (business: string) => `They won't be able to sign in to ${business}. You can invite them again anytime.`,
    removed: "Access removed.",
    roleChanged: "Role updated.",
    readOnly: "Only admins can invite people, change roles or remove access.",
    roleHelp: "Admins set up the business. Staff see the schedule and handle conversations.",
    errors: {
      LAST_ADMIN: "The business needs at least one admin.",
      YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER: "The business needs its owner.",
      USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION: "That person is already part of the business.",
      USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION: "That person already has a pending invitation. Use Resend.",
      INVALID_ROLE: "Invite as admin or staff.",
      BUSINESS_SUSPENDED: "Your business is suspended: users can't be changed.",
      BUSINESS_CLOSED: "This business was closed.",
    },
  },
  staffNote: "You're staff: you can see the setup, but not change it.",
  cfg: configEn,
  agenda: agendaEn,
  inbox: inboxEn,
  metrics: metricsEn,
  platform: platformEn,
};

export const MESSAGES: Record<Locale, Messages> = { es, en };

const STORAGE_KEY = "hablahora-console-locale";

/** Idioma antes de ingresar: el elegido antes en este navegador, o el del navegador. */
export function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "es" || stored === "en") return stored;
  } catch {
    /* sin almacenamiento */
  }
  for (const lang of navigator.languages ?? [navigator.language]) {
    const base = lang.toLowerCase().split("-")[0];
    if (base === "es" || base === "en") return base;
  }
  return "es";
}

interface I18n {
  locale: Locale;
  t: Messages;
  setLocale: (l: Locale) => void;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    document.documentElement.lang = l;
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* sin almacenamiento */
    }
  }, []);
  const value = useMemo(() => ({ locale, t: MESSAGES[locale], setLocale }), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n fuera de I18nProvider");
  return ctx;
}

/** Fecha corta en el idioma de la consola. */
export function formatDate(iso: string | Date, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "es", { day: "numeric", month: "short", year: "numeric" }).format(
    typeof iso === "string" ? new Date(iso) : iso,
  );
}
