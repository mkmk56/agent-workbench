import {
  AlertDialog,
  Badge as AstryxBadge,
  Banner,
  Button,
  EmptyState,
  ProgressBar,
  SegmentedControl,
  SegmentedControlItem,
  StatusDot,
  Switch,
  Table,
  TextArea,
  TextInput,
  proportional,
} from '@astryxdesign/core';
import { Search } from 'lucide-react';
import type { ReactNode } from 'react';

export type ActionTone = 'primary' | 'secondary' | 'ghost' | 'danger';
export type BrandStatusTone = 'running' | 'success' | 'warning' | 'error' | 'neutral';
export type BrandBadgeTone = 'running' | 'success' | 'warning' | 'error' | 'neutral';

interface AppButtonProps {
  label: string;
  children?: ReactNode;
  tone?: ActionTone;
  size?: 'sm' | 'md' | 'lg';
  icon?: ReactNode;
  onClick?: () => void;
  isDisabled?: boolean;
  isLoading?: boolean;
  className?: string;
  title?: string;
  type?: 'button' | 'submit';
}

export function AppButton({
  label,
  children,
  tone = 'secondary',
  size = 'md',
  icon,
  onClick,
  isDisabled,
  isLoading,
  className,
  title,
  type = 'button',
}: AppButtonProps) {
  return (
    <Button
      label={label}
      variant={tone === 'danger' ? 'destructive' : tone}
      size={size}
      icon={icon}
      onClick={onClick}
      isDisabled={isDisabled}
      isLoading={isLoading}
      className={className}
      tooltip={title}
      type={type}
    >
      {children ?? label}
    </Button>
  );
}

interface AppIconButtonProps {
  label: string;
  icon: ReactNode;
  tone?: ActionTone;
  size?: 'sm' | 'md' | 'lg';
  onClick?: () => void;
  isDisabled?: boolean;
  className?: string;
  title?: string;
}

export function AppIconButton({
  label,
  icon,
  tone = 'ghost',
  size = 'sm',
  onClick,
  isDisabled,
  className,
  title,
}: AppIconButtonProps) {
  return (
    <Button
      label={label}
      variant={tone === 'danger' ? 'destructive' : tone}
      size={size}
      icon={icon}
      isIconOnly
      onClick={onClick}
      isDisabled={isDisabled}
      className={['app-icon-button', className].filter(Boolean).join(' ')}
      tooltip={title}
    />
  );
}

const STATUS_DOT_VARIANT = {
  running: 'accent',
  success: 'success',
  warning: 'warning',
  error: 'error',
  neutral: 'neutral',
} as const;

export function AppStatus({
  tone,
  label,
  isPulsing = false,
}: {
  tone: BrandStatusTone;
  label: string;
  isPulsing?: boolean;
}) {
  return (
    <span className={`status status--${tone}`}>
      <StatusDot variant={STATUS_DOT_VARIANT[tone]} label={label} isPulsing={isPulsing} />
      <span>{label}</span>
    </span>
  );
}

const BADGE_VARIANT = {
  running: 'orange',
  success: 'success',
  warning: 'warning',
  error: 'error',
  neutral: 'neutral',
} as const;

export function AppBadge({ tone, label }: { tone: BrandBadgeTone; label: string }) {
  return <AstryxBadge variant={BADGE_VARIANT[tone]} label={label} />;
}

interface Segment {
  value: string;
  label: string;
}

export function AppSegmented({
  label,
  value,
  segments,
  onChange,
  size = 'md',
  className,
}: {
  label: string;
  value: string;
  segments: Segment[];
  onChange: (value: string) => void;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  return (
    <SegmentedControl
      label={label}
      value={value}
      onChange={onChange}
      size={size}
      className={className}
    >
      {segments.map((segment) => (
        <SegmentedControlItem key={segment.value} value={segment.value} label={segment.label} />
      ))}
    </SegmentedControl>
  );
}

export function AppSearch({
  label,
  value,
  onChange,
  placeholder,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <TextInput
      label={label}
      isLabelHidden
      value={value}
      onChange={(next) => onChange(next)}
      placeholder={placeholder}
      startIcon={<Search size={15} aria-hidden="true" />}
      size="sm"
      hasClear
      containerClassName={['search-field', className].filter(Boolean).join(' ')}
    />
  );
}

export function AppTextField({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  isLabelHidden = false,
  containerClassName,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: 'text' | 'password';
  isLabelHidden?: boolean;
  containerClassName?: string;
}) {
  return (
    <TextInput
      label={label}
      isLabelHidden={isLabelHidden}
      type={type}
      value={value}
      onChange={(next) => onChange(next)}
      placeholder={placeholder}
      size="sm"
      containerClassName={containerClassName}
    />
  );
}

export function AppTextArea({
  label,
  value,
  onChange,
  placeholder,
  rows = 3,
  maxLength,
  containerClassName,
  id,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  maxLength?: number;
  containerClassName?: string;
  id?: string;
}) {
  return (
    <TextArea
      label={label}
      isLabelHidden
      value={value}
      onChange={(next) => onChange(next)}
      placeholder={placeholder}
      rows={rows}
      maxLength={maxLength}
      size="md"
      containerClassName={containerClassName}
      id={id}
    />
  );
}

export function AppSwitch({
  label,
  value,
  onChange,
  isDisabled = false,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  isDisabled?: boolean;
}) {
  return (
    <Switch
      label={label}
      isLabelHidden
      value={value}
      onChange={onChange}
      isDisabled={isDisabled}
    />
  );
}

export function AppBanner({
  status,
  title,
  description,
  endContent,
  className,
}: {
  status: 'info' | 'warning' | 'error' | 'success';
  title: string;
  description?: string;
  endContent?: ReactNode;
  className?: string;
}) {
  return (
    <Banner
      status={status}
      title={title}
      description={description}
      endContent={endContent}
      container="section"
      className={['brand-banner', className].filter(Boolean).join(' ')}
    />
  );
}

export function AppEmptyState({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <EmptyState
      title={title}
      description={description}
      icon={icon}
      actions={action}
      className="empty-brand"
    />
  );
}

export function AppProgress({
  label,
  value,
  max = 100,
}: {
  label: string;
  value: number;
  max?: number;
}) {
  return (
    <ProgressBar
      label={label}
      isLabelHidden
      value={value}
      max={max}
      className="progress-brand"
    />
  );
}

export { AlertDialog, Table, proportional };