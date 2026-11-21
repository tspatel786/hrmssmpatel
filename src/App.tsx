import { lazy, Suspense, type ComponentType } from 'react';
import { Route, Routes } from 'react-router-dom';
import { AppLayout, RequirePermission } from './components/layout/AppLayout';
import { PageLoader } from './components/ui';

// route-level code splitting
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const l = <T extends Record<string, any>>(f: () => Promise<T>, name: keyof T) =>
  lazy(() => f().then((m) => ({ default: m[name] as ComponentType })));

const Landing = l(() => import('./pages/public/Landing'), 'Landing');
const Login = l(() => import('./pages/auth/Auth'), 'Login');
const Signup = l(() => import('./pages/auth/Auth'), 'Signup');
const ForgotPassword = l(() => import('./pages/auth/Auth'), 'ForgotPassword');
const ResetPassword = l(() => import('./pages/auth/Auth'), 'ResetPassword');
const CreateCompany = l(() => import('./pages/auth/CreateCompany'), 'CreateCompany');
const CareersHome = l(() => import('./pages/public/Careers'), 'CareersHome');
const CareersJob = l(() => import('./pages/public/Careers'), 'CareersJob');
const OfferResponse = l(() => import('./pages/public/OfferResponse'), 'OfferResponse');
const JoiningDocuments = l(() => import('./pages/public/JoiningDocuments'), 'JoiningDocuments');
const ActivateAccount = l(() => import('./pages/auth/Auth'), 'ActivateAccount');
const InternalOpenings = l(() => import('./pages/app/recruitment/InternalOpenings'), 'InternalOpenings');
const Exits = l(() => import('./pages/app/exits/Exits'), 'Exits');
const ExitDetail = l(() => import('./pages/app/exits/Exits'), 'ExitDetail');
const Documents = l(() => import('./pages/app/Documents'), 'Documents');
const Dashboard = l(() => import('./pages/app/Dashboard'), 'Dashboard');
const Requisitions = l(() => import('./pages/app/recruitment/Requisitions'), 'Requisitions');
const Jobs = l(() => import('./pages/app/recruitment/Jobs'), 'Jobs');
const JobDetail = l(() => import('./pages/app/recruitment/JobDetail'), 'JobDetail');
const Candidates = l(() => import('./pages/app/recruitment/Candidates'), 'Candidates');
const CandidateDetail = l(() => import('./pages/app/recruitment/CandidateDetail'), 'CandidateDetail');
const Pipeline = l(() => import('./pages/app/recruitment/Pipeline'), 'Pipeline');
const Interviews = l(() => import('./pages/app/recruitment/Interviews'), 'Interviews');
const Offers = l(() => import('./pages/app/offers/Offers'), 'Offers');
const OfferDetail = l(() => import('./pages/app/offers/OfferDetail'), 'OfferDetail');
const Onboarding = l(() => import('./pages/app/onboarding/Onboarding'), 'Onboarding');
const OnboardingDetail = l(() => import('./pages/app/onboarding/Onboarding'), 'OnboardingDetail');
const Employees = l(() => import('./pages/app/employees/Employees'), 'Employees');
const EmployeeDetail = l(() => import('./pages/app/employees/EmployeeDetail'), 'EmployeeDetail');
const Organization = l(() => import('./pages/app/Organization'), 'Organization');
const Attendance = l(() => import('./pages/app/Attendance'), 'Attendance');
const Leave = l(() => import('./pages/app/Leave'), 'Leave');
const Payroll = l(() => import('./pages/app/payroll/Payroll'), 'Payroll');
const PayrollRun = l(() => import('./pages/app/payroll/Payroll'), 'PayrollRun');
const MyPayslips = l(() => import('./pages/app/payroll/Payroll'), 'MyPayslips');
const Reports = l(() => import('./pages/app/Reports'), 'Reports');
const Emails = l(() => import('./pages/app/Emails'), 'Emails');
const Notifications = l(() => import('./pages/app/Notifications'), 'Notifications');
const Audit = l(() => import('./pages/app/Audit'), 'Audit');
const Settings = l(() => import('./pages/app/settings/Settings'), 'Settings');
const Profile = l(() => import('./pages/app/Profile'), 'Profile');
const Communication = l(() => import('./pages/app/communication/Communication'), 'Communication');
const Admin = l(() => import('./pages/admin/Admin'), 'Admin');
const NotFound = l(() => import('./pages/NotFound'), 'NotFound');

const P = ({ perm, children }: { perm: string | string[]; children: React.ReactNode }) => <RequirePermission perm={perm}>{children}</RequirePermission>;

export default function App() {
  return (
    <Suspense fallback={<div className="flex min-h-[60vh] items-center justify-center"><PageLoader /></div>}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/onboarding/company" element={<CreateCompany />} />
        <Route path="/careers/:slug" element={<CareersHome />} />
        <Route path="/careers/:slug/jobs/:jobId" element={<CareersJob />} />
        <Route path="/offer/:token" element={<OfferResponse />} />
        <Route path="/joining-documents/:token" element={<JoiningDocuments />} />
        <Route path="/activate/:token" element={<ActivateAccount />} />
        <Route path="/admin" element={<Admin />} />

        <Route path="/app" element={<AppLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="notifications" element={<Notifications />} />
          <Route path="communication" element={<Communication />} />
          <Route path="profile" element={<Profile />} />
          <Route path="openings" element={<InternalOpenings />} />
          <Route path="exits" element={<Exits />} />
          <Route path="exits/:id" element={<ExitDetail />} />
          <Route path="documents" element={<Documents />} />
          <Route path="recruitment/requisitions" element={<P perm={['requisitions.view', 'requisitions.manage', 'requisitions.approve']}><Requisitions /></P>} />
          <Route path="recruitment/jobs" element={<P perm={['jobs.view', 'jobs.manage']}><Jobs /></P>} />
          <Route path="recruitment/jobs/:id" element={<P perm={['jobs.view', 'jobs.manage', 'candidates.view']}><JobDetail /></P>} />
          <Route path="recruitment/candidates" element={<P perm="candidates.view"><Candidates /></P>} />
          <Route path="recruitment/candidates/:id" element={<CandidateDetail />} />
          <Route path="recruitment/pipeline" element={<P perm="candidates.view"><Pipeline /></P>} />
          <Route path="recruitment/interviews" element={<Interviews />} />
          <Route path="offers" element={<P perm={['offers.view', 'offers.approve']}><Offers /></P>} />
          <Route path="offers/:id" element={<P perm={['offers.view', 'offers.approve']}><OfferDetail /></P>} />
          <Route path="onboarding" element={<P perm="onboarding.view"><Onboarding /></P>} />
          <Route path="onboarding/:id" element={<P perm="onboarding.view"><OnboardingDetail /></P>} />
          <Route path="employees" element={<P perm="employees.view"><Employees /></P>} />
          <Route path="employees/:id" element={<EmployeeDetail />} />
          <Route path="organization" element={<P perm="departments.view"><Organization /></P>} />
          <Route path="attendance" element={<Attendance />} />
          <Route path="leave" element={<Leave />} />
          <Route path="payroll" element={<P perm="payroll.view"><Payroll /></P>} />
          <Route path="payroll/my-payslips" element={<MyPayslips />} />
          <Route path="payroll/:id" element={<P perm="payroll.view"><PayrollRun /></P>} />
          <Route path="reports" element={<P perm="reports.view"><Reports /></P>} />
          <Route path="emails" element={<P perm="emails.manage"><Emails /></P>} />
          <Route path="audit" element={<P perm="audit.view"><Audit /></P>} />
          <Route path="settings" element={<P perm={['settings.manage', 'users.manage']}><Settings /></P>} />
          <Route path="*" element={<NotFound />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}
