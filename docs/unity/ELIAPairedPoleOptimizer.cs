using System;
using System.Collections;

// Second-order finite elbow-circle path, ported from solve_elia_paired_pole.py
// with bridge=True and budget=.25. Fixed paired wrists, unchanged baseline world
// palms. This is not an anatomical certification or global continuous optimum.
// Pure managed arithmetic used by the private playback preparation.
internal static class ELIAPairedPoleOptimizer
{
    internal const string Version="paired-polebridge49-v1";
    const int C=49,P=18,QPerFrame=24;
    const double Budget=.25;
    internal static double[] Solve(double[] actual,double[] paired,double[] original,
        double[] worldRotations,double[] torsoRotations,Func<bool> cancelled=null)
    {
        double[] result=null;
        var job=Prepare(actual,paired,original,worldRotations,torsoRotations,r=>result=r,cancelled);
        while(job.MoveNext()) {}
        return result;
    }
    internal static IEnumerator Prepare(double[] actual,double[] paired,double[] original,
        double[] worldRotations,double[] torsoRotations,Action<double[]> completed,Func<bool> cancelled=null)
    {
        int n=actual==null?0:actual.Length/P;
        if(n<3 || actual.Length!=n*P || paired==null || paired.Length!=actual.Length ||
            original==null || original.Length!=actual.Length || worldRotations==null ||
            worldRotations.Length!=n*QPerFrame || torsoRotations==null || torsoRotations.Length!=n*4)
            throw new ArgumentException("Invalid elbow path sequence shape.");
        foreach(var input in new[]{actual,paired,original,worldRotations,torsoRotations})foreach(double v in input)
            if(double.IsNaN(v)||double.IsInfinity(v))throw new ArgumentException("Non-finite elbow path input.");
        var result=(double[])paired.Clone();
        for(int side=0;side<2;side++)
        {
            var job=SolveSide(actual,result,original,worldRotations,torsoRotations,side,cancelled);
            while(job.MoveNext())yield return null;
        }
        completed(result);
    }
    static void Check(Func<bool> cancelled)
    {if(cancelled!=null && cancelled())throw new OperationCanceledException();}
    static V Point(double[] x,int frame,int point)=>new V(x,frame*P+point*3);
    static R Joint(double[] x,int frame,int joint)=>new R(x,frame*QPerFrame+joint*4);

    static IEnumerator SolveSide(double[] a,double[] b,double[] o,double[] q,double[] bases,int side,Func<bool> cancelled)
    {
        int n=a.Length/P,j=side*3;
        var elbows=new V[n*C];var rotations=new R[n*C*2];var valid=new bool[n*C];var costs=new double[n*C];
        for(int k=0;k<n;k++)
        {
            Check(cancelled);
            V shoulder=Point(b,k,j),elbow=Point(b,k,j+1),wrist=Point(b,k,j+2);
            V axis=(wrist-shoulder).Unit();V center=shoulder+axis*V.Dot(elbow-shoulder,axis);
            V pole=elbow-center;double radius=pole.Length;
            double maximum=2*Math.Asin(Math.Min(.95,Budget/Math.Max(2*radius,1e-10)));
            V reference=Point(o,k,j+1);
            double limit=(Point(a,k,j+1)-reference).XYLength;
            R torso=new R(bases,k*4);
            if(torso.Length<1e-8)throw new ArithmeticException("Degenerate torso orientation.");
            for(int c=0;c<C;c++)
            {
                double theta=(-1+2.0*c/(C-1))*maximum;
                V e=center+pole*Math.Cos(theta)+V.Cross(axis,pole)*Math.Sin(theta);
                int node=k*C+c;elbows[node]=e;
                double xy=(e-reference).XYLength;
                valid[node]=xy<=limit+1e-9 || c==C/2;
                costs[node]=xy*xy/.0001+.12*(e-elbow).Squared/(Budget*Budget);
                for(int bone=0;bone<2;bone++)
                {
                    V old=Point(a,k,j+bone+1)-Point(a,k,j+bone);
                    V next=bone==0?e-shoulder:wrist-e;
                    rotations[node*2+bone]=Align(old,next,torso,Joint(q,k,j+bone));
                }
            }
            yield return null;
        }
        V[] velocity;double[] edge;
        BuildEdge(1,a,q,j,elbows,rotations,valid,costs,out velocity,out edge);
        var dp=new double[C*C];
        for(int from=0;from<C;from++)for(int to=0;to<C;to++)dp[from*C+to]=costs[from]+edge[from*C+to];
        var history=new byte[n][];
        for(int k=2;k<n;k++)
        {
            Check(cancelled);
            V[] nextVelocity;double[] nextEdge;
            BuildEdge(k,a,q,j,elbows,rotations,valid,costs,out nextVelocity,out nextEdge);
            var next=new double[C*C];var chosen=new byte[C*C];
            for(int previous=0;previous<C;previous++)for(int current=0;current<C;current++)
            {
                int target=previous*C+current;
                // An inadmissible edge cannot participate in any finite path.
                // Keep the valid graph, arithmetic and ascending tie order;
                // only avoid evaluating paths already known to be impossible.
                if(double.IsPositiveInfinity(nextEdge[target]))
                {next[target]=double.PositiveInfinity;continue;}
                double best=double.PositiveInfinity;byte bestIndex=0;
                for(int old=0;old<C;old++)
                {
                    int origin=old*C+previous;
                    if(double.IsPositiveInfinity(dp[origin]))continue;
                    V d0=nextVelocity[target*2]-velocity[origin*2];
                    V d1=nextVelocity[target*2+1]-velocity[origin*2+1];
                    double candidate=dp[origin]+(d0.Squared+d1.Squared)/4;
                    if(candidate<best){best=candidate;bestIndex=(byte)old;}
                }
                next[target]=best+nextEdge[target];chosen[target]=bestIndex;
            }
            dp=next;history[k]=chosen;velocity=nextVelocity;
            yield return null;
        }
        int end=0;for(int i=1;i<dp.Length;i++)if(dp[i]<dp[end])end=i;
        if(double.IsInfinity(dp[end]))throw new ArithmeticException("No valid elbow path; retain baseline.");
        var path=new int[n];path[n-2]=end/C;path[n-1]=end%C;
        for(int k=n-1;k>1;k--)path[k-2]=history[k][path[k-1]*C+path[k]];
        for(int k=0;k<n;k++)
        {
            V e=elbows[k*C+path[k]];int offset=k*P+(j+1)*3;
            b[offset]=e.X;b[offset+1]=e.Y;b[offset+2]=e.Z;
        }
    }
    static void BuildEdge(int k,double[] actual,double[] baseline,int j,V[] elbows,R[] rotations,
        bool[] valid,double[] nodes,out V[] velocity,out double[] costs)
    {
        velocity=new V[C*C*2];costs=new double[C*C];
        double step=(Point(actual,k,j+1)-Point(actual,k-1,j+1)).Length;
        double speed0=R.Velocity(Joint(baseline,k,j),Joint(baseline,k-1,j)).Length;
        double speed1=R.Velocity(Joint(baseline,k,j+1),Joint(baseline,k-1,j+1)).Length;
        for(int previous=0;previous<C;previous++)for(int current=0;current<C;current++)
        {
            int before=(k-1)*C+previous,after=k*C+current,edge=previous*C+current;
            if(!valid[before] || !valid[after])
            {costs[edge]=double.PositiveInfinity;continue;}
            V v0=R.Velocity(rotations[after*2],rotations[before*2]);
            V v1=R.Velocity(rotations[after*2+1],rotations[before*2+1]);
            velocity[edge*2]=v0;velocity[edge*2+1]=v1;
            double amplification=Math.Max(0,(elbows[after]-elbows[before]).Length-step-.002)/.01;
            double excess0=Math.Max(0,v0.Length-speed0)/2,excess1=Math.Max(0,v1.Length-speed1)/2;
            costs[edge]=valid[before] && valid[after]
                ? 8*amplification*amplification+excess0*excess0+excess1*excess1+nodes[after]
                : double.PositiveInfinity;
        }
    }
    static R Align(V old,V next,R torso,R baseline)
    {
        old=old.Unit();next=next.Unit();double w=1+V.Dot(old,next);
        if(w<=1e-8)throw new ArithmeticException("Antiparallel arm axis; retain baseline.");
        R delta=new R(V.Cross(old,next),w).Unit();
        return (torso*delta*torso.Conjugate()*baseline).Unit();
    }
    readonly struct V
    {
        internal readonly double X,Y,Z;
        internal V(double x,double y,double z){X=x;Y=y;Z=z;}
        internal V(double[] a,int i):this(a[i],a[i+1],a[i+2]){}
        internal double Squared=>X*X+Y*Y+Z*Z;
        internal double Length=>Math.Sqrt(Squared);
        internal double XYLength=>Math.Sqrt(X*X+Y*Y);
        internal V Unit(){double n=Length;if(n<1e-12)throw new ArithmeticException("Degenerate axis.");return this*(1/n);}
        internal static double Dot(V a,V b)=>a.X*b.X+a.Y*b.Y+a.Z*b.Z;
        internal static V Cross(V a,V b)=>new V(a.Y*b.Z-a.Z*b.Y,a.Z*b.X-a.X*b.Z,a.X*b.Y-a.Y*b.X);
        public static V operator+(V a,V b)=>new V(a.X+b.X,a.Y+b.Y,a.Z+b.Z);
        public static V operator-(V a,V b)=>new V(a.X-b.X,a.Y-b.Y,a.Z-b.Z);
        public static V operator*(V a,double b)=>new V(a.X*b,a.Y*b,a.Z*b);
    }
    readonly struct R
    {
        internal readonly V XYZ;internal readonly double W;
        internal R(V v,double w){XYZ=v;W=w;}
        internal R(double[] a,int i):this(new V(a,i),a[i+3]){}
        internal double Length=>Math.Sqrt(XYZ.Squared+W*W);
        internal R Unit(){double n=Length;if(n<1e-12)throw new ArithmeticException("Degenerate rotation.");return new R(XYZ*(1/n),W/n);}
        internal R Conjugate()=>new R(XYZ*(-1),W);
        public static R operator*(R a,R b)=>new R(b.XYZ*a.W+a.XYZ*b.W+V.Cross(a.XYZ,b.XYZ),a.W*b.W-V.Dot(a.XYZ,b.XYZ));
        internal static V Velocity(R current,R previous)
        {
            R delta=current*previous.Conjugate();
            double sign=delta.W<0?-1:1,n=delta.XYZ.Length;
            return delta.XYZ*(sign*2*Math.Atan2(n,delta.W*sign)/Math.Max(n,1e-12)*180/Math.PI);
        }
    }
}
