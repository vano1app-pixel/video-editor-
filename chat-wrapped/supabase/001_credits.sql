-- Chat Wrapped credit ledger.
--
-- Tables live in `public` with a cw_ prefix so PostgREST picks them up with no
-- extra schema configuration. RLS is on with no policies, so anon and
-- authenticated keys can read nothing — only the service role key, which is
-- server-side only, can touch these tables.

create table if not exists public.cw_credits (
  key_hash   text primary key,
  credits    integer not null default 0 check (credits >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Maps a completed Stripe Checkout session to the key minted for it, so the
-- buyer can collect their key after the redirect.
create table if not exists public.cw_checkouts (
  checkout_id text primary key,
  key         text not null,
  created_at  timestamptz not null default now()
);

-- Fixed-window rate limiting. Shared across every server instance, unlike the
-- in-process counter it replaces.
create table if not exists public.cw_rate_limits (
  bucket   text primary key,
  count    integer not null default 0,
  reset_at timestamptz not null
);

alter table public.cw_credits     enable row level security;
alter table public.cw_checkouts   enable row level security;
alter table public.cw_rate_limits enable row level security;

-- Grant credits, creating the key row if it is new. Idempotent per checkout:
-- Stripe retries webhooks, and a retry must not grant a second time.
create or replace function public.cw_grant_credits(
  p_key_hash    text,
  p_reports     integer,
  p_key         text,
  p_checkout_id text default null
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_credits integer;
begin
  if p_checkout_id is not null then
    -- If this checkout was already recorded, return the current balance
    -- without granting anything further.
    if exists (select 1 from public.cw_checkouts where checkout_id = p_checkout_id) then
      select credits into v_credits from public.cw_credits where key_hash = p_key_hash;
      return coalesce(v_credits, 0);
    end if;
  end if;

  insert into public.cw_credits (key_hash, credits)
  values (p_key_hash, p_reports)
  on conflict (key_hash) do update
    set credits = public.cw_credits.credits + excluded.credits,
        updated_at = now()
  returning credits into v_credits;

  if p_checkout_id is not null then
    insert into public.cw_checkouts (checkout_id, key)
    values (p_checkout_id, p_key)
    on conflict (checkout_id) do nothing;
  end if;

  return v_credits;
end;
$$;

-- Atomic spend. A single UPDATE guarded by credits > 0 means two concurrent
-- requests can never both take the last credit.
create or replace function public.cw_spend_credit(p_key_hash text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_credits integer;
begin
  update public.cw_credits
     set credits = credits - 1,
         updated_at = now()
   where key_hash = p_key_hash
     and credits > 0
  returning credits into v_credits;

  -- NULL means unknown key or empty balance; callers must not call the model.
  return v_credits;
end;
$$;

create or replace function public.cw_refund_credit(p_key_hash text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_credits integer;
begin
  update public.cw_credits
     set credits = credits + 1,
         updated_at = now()
   where key_hash = p_key_hash
  returning credits into v_credits;
  return v_credits;
end;
$$;

-- Fixed-window counter. Returns the count *after* this hit, so the caller
-- compares against its own max.
create or replace function public.cw_rate_limit(
  p_bucket         text,
  p_window_seconds integer
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into public.cw_rate_limits (bucket, count, reset_at)
  values (p_bucket, 1, now() + make_interval(secs => p_window_seconds))
  on conflict (bucket) do update
    set count    = case
                     when public.cw_rate_limits.reset_at < now() then 1
                     else public.cw_rate_limits.count + 1
                   end,
        reset_at = case
                     when public.cw_rate_limits.reset_at < now()
                       then now() + make_interval(secs => p_window_seconds)
                     else public.cw_rate_limits.reset_at
                   end
  returning count into v_count;

  return v_count;
end;
$$;

-- Housekeeping: expired rate-limit rows are dead weight.
create index if not exists cw_rate_limits_reset_at_idx on public.cw_rate_limits (reset_at);
