import { createClient } from '@supabase/supabase-js'

export const PERSONAL_SESSION_KEY = 'tam-personal-session'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Не заданы настройки Supabase')
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  global: {
    fetch: (input, init = {}) => {
      const headers = new Headers(init.headers)
      const personalToken = localStorage.getItem(PERSONAL_SESSION_KEY)
      if (personalToken) headers.set('x-tam-session', personalToken)
      return fetch(input, { ...init, headers })
    },
  },
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})
