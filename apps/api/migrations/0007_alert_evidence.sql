create function protect_alert_evidence() returns trigger language plpgsql as $$
begin
  if (to_jsonb(new)-'read_at') is distinct from (to_jsonb(old)-'read_at') then
    raise exception 'Alert evidence is immutable; only read acknowledgement may change';
  end if;
  return new;
end;
$$;
create trigger research_alert_evidence_immutable before update on research_alerts
  for each row execute function protect_alert_evidence();
create trigger research_alerts_retained before delete or truncate on research_alerts
  for each statement execute function reject_archive_mutation();
