import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Account & Sign In',
  description:
    'Sign in to your Izum StoryFlow account or manage your cloud library storage, sync, and account settings.',
};

export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
